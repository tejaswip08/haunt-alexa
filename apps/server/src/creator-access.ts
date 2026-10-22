import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { userOf } from "./auth.ts";
import type { ProfileStore } from "./profiles.ts";
import { ADMIN_ROLES, requireRole, type Role } from "./roles.ts";

/**
 * Creator access requests, stored in `haunt-users` (the same table as profiles; keys are prefixed so they can't
 * collide with a profile's Cognito `sub`).
 *
 *   creator-request#<sub>   one request per listener: PENDING, APPROVED, or REJECTED
 *   creator-pending         index: the set of subs with a PENDING request, so admins can list them without a Scan
 *   audit#<time>#<nonce>    one record per role change: actor, target, previous role, new role, reason, time
 *
 * Every decision is one DynamoDB transaction. Each write carries a condition, so a request can be decided once,
 * and a role changes only if the account is still a LISTENER. Two admins deciding at once can't both succeed.
 *
 *   GET  /api/creator-access/me                              the listener's own request status
 *   POST /api/creator-access/me                              request Creator access (LISTENER only)
 *   GET  /api/creator-access/admin/requests                  pending requests (ADMIN only)
 *   POST /api/creator-access/admin/requests/:userId/approve  approve (ADMIN only; the request must be pending)
 *   POST /api/creator-access/admin/requests/:userId/reject   reject (ADMIN only)
 */

export const REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface CreatorRequest {
  /** The storage key (`creator-request#<sub>`). Internal: clients use `subject`. */
  userId: string;
  /** The requester's Cognito `sub`: the id the admin decision routes take. */
  subject?: string;
  status: RequestStatus;
  requestedAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

const INDEX_KEY = "creator-pending";
const requestKey = (sub: string) => `creator-request#${sub}`;
/** Cognito subs are UUIDs. Anything else can't be a real account, so it's refused before the database is touched. */
const SUB = /^[0-9a-fA-F-]{8,64}$/;

const now = () => new Date().toISOString();
const nonce = () => randomBytes(8).toString("hex");

export class CreatorAccessStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string,
    private readonly profiles: ProfileStore,
  ) {}

  async getRequest(sub: string): Promise<CreatorRequest | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { userId: requestKey(sub) }, ConsistentRead: true }),
    );
    return Item ? (Item.request as CreatorRequest) : undefined;
  }

  /** A listener asks for Creator access. Fails if one is already pending or the account isn't a LISTENER. */
  async request(sub: string): Promise<CreatorRequest> {
    const profile = await this.profiles.ensure(sub, null);
    if (profile.role !== "LISTENER") throw new AccessError(409, "Your account already has a different role.");
    const stamp = now();
    const request: CreatorRequest = { userId: requestKey(sub), subject: sub, status: "PENDING", requestedAt: stamp, updatedAt: stamp };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // The account must still be a LISTENER when the request is written. Checked in this transaction, not only
              // before it, so a role change between the profile read and this write can't leave a CREATOR with a request.
              ConditionCheck: {
                TableName: this.table,
                Key: { userId: sub },
                ConditionExpression: "attribute_exists(userId) AND (attribute_not_exists(#role) OR #role = :listener)",
                ExpressionAttributeNames: { "#role": "role" },
                ExpressionAttributeValues: { ":listener": "LISTENER" },
              },
            },
            {
              // Only when there is no request, or the last one was rejected: a pending request can't be duplicated.
              Put: {
                TableName: this.table,
                Item: { userId: requestKey(sub), request },
                ConditionExpression: "attribute_not_exists(userId) OR #request.#status = :rejected",
                ExpressionAttributeNames: { "#request": "request", "#status": "status" },
                ExpressionAttributeValues: { ":rejected": "REJECTED" },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { userId: INDEX_KEY },
                UpdateExpression: "ADD #pending :sub",
                ExpressionAttributeNames: { "#pending": "pending" },
                ExpressionAttributeValues: { ":sub": new Set([sub]) },
              },
            },
          ],
        }),
      );
      return request;
    } catch (error) {
      if (isCancelled(error)) throw new AccessError(409, "You already have a Creator access request pending.");
      throw error;
    }
  }

  /** Admin: the pending requests, newest first, with the account's display details. */
  async pending(limit = 100): Promise<Array<CreatorRequest & { displayName: string | null; email: string | null }>> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { userId: INDEX_KEY }, ConsistentRead: true }),
    );
    const subs = Array.from((Item?.pending as Set<string> | undefined) ?? []).slice(0, limit);
    const rows = await Promise.all(
      subs.map(async (sub) => {
        const request = await this.getRequest(sub);
        if (!request || request.status !== "PENDING") return undefined;
        const profile = await this.profiles.get(sub);
        return { ...request, subject: sub, displayName: profile?.displayName ?? null, email: profile?.email ?? null };
      }),
    );
    return rows
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Approves a pending request and makes the account a CREATOR, in one transaction. */
  async approve(target: string, actor: string, reason?: string): Promise<void> {
    await this.decide(target, actor, "APPROVED", reason);
  }

  /** Rejects a pending request. The account stays a LISTENER and may ask again later. */
  async reject(target: string, actor: string, reason?: string): Promise<void> {
    await this.decide(target, actor, "REJECTED", reason);
  }

  private async decide(target: string, actor: string, outcome: "APPROVED" | "REJECTED", reason?: string): Promise<void> {
    const stamp = now();
    const items: NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]> = [
      {
        Update: {
          TableName: this.table,
          Key: { userId: requestKey(target) },
          UpdateExpression: "SET #request.#status = :outcome, #request.#updatedAt = :stamp, #request.#decidedAt = :stamp, #request.#decidedBy = :actor" +
            (reason ? ", #request.#reason = :reason" : ""),
          ConditionExpression: "#request.#status = :pending",
          ExpressionAttributeNames: {
            "#request": "request",
            "#status": "status",
            "#updatedAt": "updatedAt",
            "#decidedAt": "decidedAt",
            "#decidedBy": "decidedBy",
            ...(reason ? { "#reason": "reason" } : {}),
          },
          ExpressionAttributeValues: {
            ":outcome": outcome,
            ":pending": "PENDING",
            ":stamp": stamp,
            ":actor": actor,
            ...(reason ? { ":reason": reason } : {}),
          },
        },
      },
      {
        Update: {
          TableName: this.table,
          Key: { userId: INDEX_KEY },
          UpdateExpression: "DELETE #pending :sub",
          ExpressionAttributeNames: { "#pending": "pending" },
          ExpressionAttributeValues: { ":sub": new Set([target]) },
        },
      },
      {
        Put: {
          TableName: this.table,
          Item: {
            userId: `audit#${stamp}#${nonce()}`,
            audit: { actor, target, change: `creator-request ${outcome}`, reason: reason ?? null, at: stamp },
          },
          ConditionExpression: "attribute_not_exists(userId)",
        },
      },
    ];
    if (outcome === "APPROVED") {
      items.push({
        Update: {
          TableName: this.table,
          Key: { userId: target },
          UpdateExpression: "SET #role = :creator, #updatedAt = :stamp",
          // Only a LISTENER (or a profile with no role yet) becomes a CREATOR, and only if it exists.
          ConditionExpression: "attribute_exists(userId) AND (attribute_not_exists(#role) OR #role = :listener)",
          ExpressionAttributeNames: { "#role": "role", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: { ":creator": "CREATOR", ":listener": "LISTENER", ":stamp": stamp },
        },
      });
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isCancelled(error)) {
        throw new AccessError(409, "This request was already decided, or the account's role has changed.");
      }
      throw error;
    }
  }
}

export class AccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A transaction failed because a condition didn't hold (never because of a database fault). */
function isCancelled(error: unknown): boolean {
  return (error as { name?: string }).name === "TransactionCanceledException";
}

/** Route-level helper: a sub taken from the path must look like a Cognito sub before any read or write. */
function targetOf(req: Request, res: Response): string | undefined {
  const target = String(req.params.userId ?? "");
  if (!SUB.test(target)) {
    res.status(400).json({ error: "That isn't a valid account." });
    return undefined;
  }
  return target;
}

export function createCreatorAccessRouter(access: CreatorAccessStore | undefined, profiles: ProfileStore | undefined): Router {
  const router = Router();
  const unavailable = (res: Response) => res.status(503).json({ error: "Accounts aren't available on this server yet." });
  const fail = (res: Response, error: unknown) => {
    if (error instanceof AccessError) return void res.status(error.status).json({ error: error.message });
    console.error("[creator-access] failed:", (error as Error).name);
    res.status(503).json({ error: "That couldn't be saved. Try again." });
  };

  router.get("/me", async (req, res) => {
    const user = userOf(res);
    if (!user) return void res.status(401).json({ error: "Sign in to continue." });
    if (!access) return void unavailable(res);
    try {
      const request = await access.getRequest(user.sub);
      res.json({ request: request ?? null });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/me", requireRole(profiles, ["LISTENER"]), async (req, res) => {
    const user = userOf(res);
    if (!user) return void res.status(401).json({ error: "Sign in to continue." });
    if (!access) return void unavailable(res);
    try {
      res.status(201).json({ request: await access.request(user.sub) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/admin/requests", requireRole(profiles, ADMIN_ROLES), async (req, res) => {
    if (!access) return void unavailable(res);
    try {
      res.json({ requests: await access.pending() });
    } catch (error) {
      fail(res, error);
    }
  });

  for (const outcome of ["approve", "reject"] as const) {
    router.post(`/admin/requests/:userId/${outcome}`, requireRole(profiles, ADMIN_ROLES), async (req, res) => {
      const actor = userOf(res)!.sub;
      const target = targetOf(req, res);
      if (!target) return;
      // An admin can't decide their own request, and a request is never decided by its owner.
      if (target === actor) return void res.status(403).json({ error: "You can't decide your own request." });
      if (!access) return void unavailable(res);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 280) : undefined;
      try {
        if (outcome === "approve") await access.approve(target, actor, reason || undefined);
        else await access.reject(target, actor, reason || undefined);
        res.json({ ok: true, status: outcome === "approve" ? "APPROVED" : "REJECTED" });
      } catch (error) {
        fail(res, error);
      }
    });
  }

  return router;
}

export type { Role };
