import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { DEFAULT_ROLE, roleOf, type Role } from "./roles.ts";

/** A profile exists with a different role than the one a development identity should have. Nothing is changed. */
export class RoleConflictError extends Error {
  constructor(readonly userId: string, readonly actual: Role, readonly expected: Role) {
    super(`The local profile ${userId} has role ${actual}, but ${expected} was expected. Nothing was changed; fix that local record deliberately.`);
    this.name = "RoleConflictError";
  }
}

/**
 * A listener's profile, in the `haunt-users` table. The key is the Cognito `sub` of the signed-in
 * user: a server-side, immutable identifier. Never a client-supplied value.
 *
 * Nothing secret is stored here: no passwords, one-time codes, tokens, or AWS credentials.
 */

export const PROFILE_STATUSES = ["ACTIVE"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export interface ProfilePreferences {
  /** Language for stories and the interface. */
  language: "en";
  notifications: {
    /** Email about the listener's own stories. */
    email: boolean;
    /** Email about new Haunt stories. */
    productUpdates: boolean;
  };
  listening: {
    /** Continue to the next scene automatically when narration ends. */
    autoplay: boolean;
    /** Where narration comes from: the server's voice or the device's voice. */
    narration: "server" | "device";
  };
}

export interface UserProfile {
  /** The Cognito `sub`. Set once, never changed. */
  userId: string;
  /**
   * LISTENER, CREATOR, or ADMIN (roles.ts). Changed only by trusted backend operations (creator-access.ts
   * and scripts/grant-role.ts), never by a profile update.
   */
  role: "LISTENER" | "CREATOR" | "ADMIN";
  /** Only when Cognito reports the email as verified; otherwise null. */
  email: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  /** Server-generated ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  onboardingCompleted: boolean;
  preferences: ProfilePreferences;
  status: ProfileStatus;
}

/** The defaults for a new profile. These are settings, not invented user data. */
export function defaultPreferences(): ProfilePreferences {
  return {
    language: "en",
    notifications: { email: false, productUpdates: false },
    listening: { autoplay: false, narration: "server" },
  };
}

/** What a listener may change. Anything else (userId, createdAt, updatedAt, status, email) is refused. */
export const ProfilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(40).nullable().optional(),
    profileImageUrl: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((url) => url.startsWith("https://"), "The picture must use an https address.")
      .nullable()
      .optional(),
    onboardingCompleted: z.boolean().optional(),
    preferences: z
      .object({
        language: z.literal("en").optional(),
        notifications: z
          .object({ email: z.boolean().optional(), productUpdates: z.boolean().optional() })
          .strict()
          .optional(),
        listening: z
          .object({ autoplay: z.boolean().optional(), narration: z.enum(["server", "device"]).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

/** Flattens a patch into DynamoDB update parts, one attribute path per field that was sent. */
function patchParts(patch: ProfilePatch): { sets: Record<string, unknown> } {
  const sets: Record<string, unknown> = {};
  if (patch.displayName !== undefined) sets.displayName = patch.displayName;
  if (patch.profileImageUrl !== undefined) sets.profileImageUrl = patch.profileImageUrl;
  if (patch.onboardingCompleted !== undefined) sets.onboardingCompleted = patch.onboardingCompleted;
  const p = patch.preferences;
  if (p?.language !== undefined) sets["preferences.language"] = p.language;
  if (p?.notifications?.email !== undefined) sets["preferences.notifications.email"] = p.notifications.email;
  if (p?.notifications?.productUpdates !== undefined) sets["preferences.notifications.productUpdates"] = p.notifications.productUpdates;
  if (p?.listening?.autoplay !== undefined) sets["preferences.listening.autoplay"] = p.listening.autoplay;
  if (p?.listening?.narration !== undefined) sets["preferences.listening.narration"] = p.listening.narration;
  return { sets };
}

export class ProfileStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(userId: string): Promise<UserProfile | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { userId }, ConsistentRead: true }),
    );
    if (!Item) return undefined;
    // A profile written before roles existed has no role: it is a LISTENER.
    return { ...(Item as UserProfile), role: roleOf((Item as { role?: unknown }).role) };
  }

  /**
   * Development identities only (dev-identities.ts). Creates the profile with `role` if it is absent. If it exists with the same
   * role, returns it. If it exists with another role, throws RoleConflictError: a role is never changed automatically.
   */
  async provisionRole(userId: string, role: Role): Promise<UserProfile> {
    const existing = await this.get(userId);
    if (existing) {
      if (existing.role === role) return existing;
      throw new RoleConflictError(userId, existing.role, role);
    }
    const stamp = this.now().toISOString();
    const profile: UserProfile = {
      userId,
      role,
      email: null,
      displayName: null,
      profileImageUrl: null,
      createdAt: stamp,
      updatedAt: stamp,
      onboardingCompleted: false,
      preferences: defaultPreferences(),
      status: "ACTIVE",
    };
    try {
      await this.client.send(new PutCommand({ TableName: this.table, Item: profile, ConditionExpression: "attribute_not_exists(userId)" }));
      return profile;
    } catch (error) {
      if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
      // Another request created it first: judge the record that exists, and change nothing.
      const created = await this.get(userId);
      if (created?.role === role) return created;
      throw new RoleConflictError(userId, created?.role ?? DEFAULT_ROLE, role);
    }
  }

  /**
   * Returns the user's profile, creating it on first use. Never overwrites: the create is conditional
   * on the key being absent, so a second sign-in (or a retry after a failure) can't replace it with defaults.
   */
  async ensure(userId: string, verifiedEmail: string | null): Promise<UserProfile> {
    const existing = await this.get(userId);
    if (existing) {
      // A profile created before its email was verified gets the email now. Nothing else changes.
      return verifiedEmail && !existing.email ? this.recordEmail(userId, verifiedEmail) : existing;
    }
    const stamp = this.now().toISOString();
    const profile: UserProfile = {
      userId,
      role: DEFAULT_ROLE,
      email: verifiedEmail,
      displayName: null,
      profileImageUrl: null,
      createdAt: stamp,
      updatedAt: stamp,
      onboardingCompleted: false,
      preferences: defaultPreferences(),
      status: "ACTIVE",
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: profile,
          ConditionExpression: "attribute_not_exists(userId)",
        }),
      );
      return profile;
    } catch (error) {
      // Another request created it first. Return what exists; nothing is overwritten.
      if (error instanceof ConditionalCheckFailedException || (error as Error).name === "ConditionalCheckFailedException") {
        const created = await this.get(userId);
        if (created) return created;
      }
      throw error;
    }
  }

  /**
   * Sets the verified email on a profile that has none. The write only touches `email` and `updatedAt`,
   * and only while `email` is still empty, so displayName, preferences, onboardingCompleted, createdAt and
   * status are never overwritten. A concurrent writer that set the email first wins, and its value is returned.
   */
  private async recordEmail(userId: string, email: string): Promise<UserProfile> {
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { userId },
          UpdateExpression: "SET #email = :email, #updatedAt = :updatedAt",
          ConditionExpression: "attribute_exists(userId) AND (attribute_not_exists(#email) OR #email = :none)",
          ExpressionAttributeNames: { "#email": "email", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: { ":email": email, ":updatedAt": this.now().toISOString(), ":none": null },
          ReturnValues: "ALL_NEW",
        }),
      );
      return Attributes as UserProfile;
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException") {
        const current = await this.get(userId);
        if (current) return current;
      }
      throw error;
    }
  }

  /** Applies a validated patch. Requires the profile to exist, so it never creates one by accident. */
  async update(userId: string, patch: ProfilePatch): Promise<UserProfile | undefined> {
    const { sets } = patchParts(patch);
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": this.now().toISOString() };
    const clauses = ["#updatedAt = :updatedAt"];
    Object.entries(sets).forEach(([path, value], i) => {
      const segments = path.split(".");
      const placeholders = segments.map((segment, j) => {
        const name = `#f${i}_${j}`;
        names[name] = segment;
        return name;
      });
      const valueName = `:v${i}`;
      values[valueName] = value;
      clauses.push(`${placeholders.join(".")} = ${valueName}`);
    });
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { userId },
          UpdateExpression: `SET ${clauses.join(", ")}`,
          ConditionExpression: "attribute_exists(userId)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return Attributes as UserProfile | undefined;
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException") return undefined;
      throw error;
    }
  }
}
