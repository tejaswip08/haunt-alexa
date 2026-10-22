import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * A listener's viewing record: where they are in each story, and which stories they like. One item per listener in the
 * existing `haunt-users` table, keyed `<sub>#library` (no new table, no index).
 *
 *   progress: { [storyId]: { partIndex, totalParts, completed, lastPlayedAt, completedAt? } }
 *   likes:    { [storyId]: likedAt }
 *   modes:    { [storyId]: "choices" | "listen" }   the play mode the listener picked for each story
 *
 * Each story is its own map key, so a progress save and a like change touch different attributes and can't overwrite
 * each other. The like itself is written by engagement.ts in the same transaction that changes the story's total.
 */

export interface Progress {
  /** The part count along the main storyline (so Continue Watching can show "Part N of M"). */
  partIndex: number;
  /** How the listener was playing. Only "choices" playthroughs record `segment` and `history`. */
  mode?: PlayMode;
  /** The segment the listener is on, for a choices playthrough (an index into the story's segments). */
  segment?: number;
  /** Every segment visited in order, so a resume restores the exact branch taken. */
  history?: number[];
  /** Where in the story the listener was, in milliseconds from its start (the player's own clock). */
  positionMs?: number;
  totalParts: number;
  completed: boolean;
  lastPlayedAt: string;
  completedAt?: string;
}

export type PlayMode = "choices" | "listen";

export interface ViewingState {
  progress: Record<string, Progress>;
  likes: Record<string, string>;
  modes: Record<string, PlayMode>;
}

export const libraryKey = (sub: string) => `${sub}#library`;

export class ViewingStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(sub: string): Promise<ViewingState> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { userId: libraryKey(sub) }, ConsistentRead: true }),
    );
    return {
      progress: (Item?.progress ?? {}) as Record<string, Progress>,
      likes: (Item?.likes ?? {}) as Record<string, string>,
      modes: (Item?.modes ?? {}) as Record<string, PlayMode>,
    };
  }

  /**
   * Records the play mode for one story. Only this story's key changes, so it can't overwrite progress or likes. The
   * modes map is created first if the listener has none yet.
   */
  async setMode(sub: string, storyId: string, mode: PlayMode): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId: libraryKey(sub) },
        UpdateExpression: "SET #m = if_not_exists(#m, :empty)",
        ExpressionAttributeNames: { "#m": "modes" },
        ExpressionAttributeValues: { ":empty": {} },
      }),
    );
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId: libraryKey(sub) },
        UpdateExpression: "SET #m.#s = :mode",
        ExpressionAttributeNames: { "#m": "modes", "#s": storyId },
        ExpressionAttributeValues: { ":mode": mode },
      }),
    );
  }

  /** Creates the two maps when they're missing, so nested updates have a parent to write into. Safe to repeat. */
  async ensure(sub: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId: libraryKey(sub) },
        UpdateExpression: "SET #p = if_not_exists(#p, :empty), #l = if_not_exists(#l, :empty)",
        ExpressionAttributeNames: { "#p": "progress", "#l": "likes" },
        ExpressionAttributeValues: { ":empty": {} },
      }),
    );
  }

  /** Saves where the listener is in a story. Only that story's entry changes. */
  async saveProgress(
    sub: string,
    storyId: string,
    checkpoint: {
      partIndex: number;
      positionMs: number;
      totalParts: number;
      completed: boolean;
      mode?: PlayMode;
      segment?: number;
      history?: number[];
    },
  ) {
    await this.ensure(sub);
    const stamp = this.now().toISOString();
    const entry: Progress = {
      partIndex: checkpoint.partIndex,
      positionMs: checkpoint.positionMs,
      totalParts: checkpoint.totalParts,
      completed: checkpoint.completed,
      lastPlayedAt: stamp,
      ...(checkpoint.completed ? { completedAt: stamp } : {}),
      ...(checkpoint.mode ? { mode: checkpoint.mode } : {}),
      ...(checkpoint.segment !== undefined ? { segment: checkpoint.segment } : {}),
      ...(checkpoint.history ? { history: checkpoint.history } : {}),
    };
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId: libraryKey(sub) },
        UpdateExpression: "SET #p.#s = :entry",
        ExpressionAttributeNames: { "#p": "progress", "#s": storyId },
        ExpressionAttributeValues: { ":entry": entry },
      }),
    );
  }
}
