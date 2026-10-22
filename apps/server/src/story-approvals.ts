import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isConditionFailure } from "./split-records.ts";
import { storyFits, type UserStoryRecord, type UserStoryStore } from "./user-stories.ts";

/**
 * Admin approval for My Stories. The table `haunt-story-approvals` is the source of truth for every review decision. A story
 * only reaches Community through `approve`, which changes the submission and the story in one DynamoDB transaction.
 *
 *   key          submissionId = "<storyId>#<version>"   one submission per story revision, so a repeat submit is idempotent
 *   attributes   storyId, submittedBy, status, submittedAt, version, reviewedBy?, reviewedAt?, rejectionReason?, note?
 *   indexes      status-submitted  (status, submittedAt)   the review queue
 *                creator-submitted (submittedBy, submittedAt)  a creator's history
 *                story-submitted   (storyId, submittedAt)  one story's history
 *
 * The story is never copied here. A submission names the story revision it reviewed; approval refuses if the story has moved on.
 */

export const SUBMISSION_STATUSES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const REASON_LIMIT = 500;

export interface SubmissionRecord {
  submissionId: string;
  storyId: string;
  submittedBy: string;
  status: SubmissionStatus;
  submittedAt: string;
  /** The story revision (its version) that was submitted. */
  version: number;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  /** Why a pending submission was withdrawn by the system (for example, the story was edited). */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "invalid" | "conflict" | "stale",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export function submissionIdFor(storyId: string, version: number): string {
  return `${storyId}#${version}`;
}

export class StoryApprovalStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string,
    private readonly storiesTable: string,
    private readonly stories: UserStoryStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async get(submissionId: string): Promise<SubmissionRecord | undefined> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: { submissionId }, ConsistentRead: true }));
    return Item as SubmissionRecord | undefined;
  }

  /** The creator's own submission for their story revision. Reads only; nothing is changed. */
  async listForCreator(owner: string, limit = 100): Promise<SubmissionRecord[]> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "creator-submitted",
        KeyConditionExpression: "submittedBy = :u",
        ExpressionAttributeValues: { ":u": owner },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []) as SubmissionRecord[];
  }

  async listForStory(storyId: string, limit = 100): Promise<SubmissionRecord[]> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "story-submitted",
        KeyConditionExpression: "storyId = :s",
        ExpressionAttributeValues: { ":s": storyId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []) as SubmissionRecord[];
  }

  /** The review queue for one status. Pending comes oldest first, so nothing waits forever behind newer items. */
  async listByStatus(status: SubmissionStatus, limit = 50): Promise<SubmissionRecord[]> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "status-submitted",
        KeyConditionExpression: "#s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
        ScanIndexForward: status === "PENDING_APPROVAL",
        Limit: limit,
      }),
    );
    return (out.Items ?? []) as SubmissionRecord[];
  }

  /**
   * Submits the story's current revision for review. The story must be a draft and pass the same checks as a publish. The story
   * is not published, and its status stays "draft". A repeat submit of the same revision returns the pending one.
   */
  async submit(owner: string, hauntId: string): Promise<SubmissionRecord> {
    const record = await this.stories.get(owner, hauntId);
    if (!record) throw new ApprovalError("not_found", "No such story.");
    // A draft or a published story may be submitted. A published story's new revision stays private until it is approved;
    // its approved revision keeps showing in Community meanwhile.
    const { problems } = await this.stories.preview(owner, hauntId);
    if (problems.length) throw new ApprovalError("invalid", "Fix these before you submit the story for review.", problems);
    if (!storyFits(record.story)) {
      throw new ApprovalError("invalid", "This story is too long to publish alongside its new revision. Shorten it, or unpublish it first.");
    }

    const submissionId = submissionIdFor(hauntId, record.version);
    const existing = await this.get(submissionId);
    if (existing?.status === "PENDING_APPROVAL") return existing;
    if (existing) throw new ApprovalError("conflict", `This version was already ${existing.status.toLowerCase().replace("_", " ")}. Edit the story to submit it again.`);

    await this.withdrawPending(owner, hauntId, "A newer version was submitted.");
    const stamp = this.now();
    const submission: SubmissionRecord = {
      submissionId,
      storyId: hauntId,
      submittedBy: owner,
      status: "PENDING_APPROVAL",
      submittedAt: stamp,
      version: record.version,
      createdAt: stamp,
      updatedAt: stamp,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.table, Item: submission, ConditionExpression: "attribute_not_exists(submissionId)" } },
            // The story must still be this exact revision, so the reviewed content is the submitted content.
            {
              ConditionCheck: {
                TableName: this.storiesTable,
                Key: { userId: owner, hauntId },
                ConditionExpression: "#v = :v",
                ExpressionAttributeNames: { "#v": "version" },
                ExpressionAttributeValues: { ":v": record.version },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      throw new ApprovalError("conflict", "The story changed while you were submitting it. Reload it and submit again.");
    }
    return submission;
  }

  /** Withdraws the story's pending submissions, for example after the creator edits it. The approval check still guards the story. */
  async withdrawPending(owner: string, storyId: string, note: string): Promise<number> {
    const pending = (await this.listForStory(storyId)).filter((s) => s.status === "PENDING_APPROVAL" && s.submittedBy === owner);
    for (const submission of pending) {
      const stamp = this.now();
      try {
        await this.client.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { submissionId: submission.submissionId },
            UpdateExpression: "SET #s = :w, note = :n, updatedAt = :t",
            ConditionExpression: "#s = :p",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":w": "WITHDRAWN", ":p": "PENDING_APPROVAL", ":n": note, ":t": stamp },
          }),
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    return pending.length;
  }

  /**
   * Approves a pending submission. Refused for the creator's own story, and when the story is no longer the reviewed revision.
   * One transaction moves the submission to APPROVED and the story to published. A repeat of an approval returns the approved one.
   */
  async approve(reviewer: string, submissionId: string): Promise<SubmissionRecord> {
    const submission = await this.get(submissionId);
    if (!submission) throw new ApprovalError("not_found", "No such submission.");
    if (submission.submittedBy === reviewer) throw new ApprovalError("forbidden", "You can't approve your own story.");
    if (submission.status === "APPROVED") return submission;
    if (submission.status !== "PENDING_APPROVAL") throw new ApprovalError("conflict", `This submission is ${submission.status.toLowerCase().replace("_", " ")}.`);

    const story = await this.stories.get(submission.submittedBy, submission.storyId);
    if (!story || story.version !== submission.version) {
      throw new ApprovalError("stale", "The story changed after it was submitted. The creator needs to submit it again.");
    }
    const stamp = this.now();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { submissionId },
                UpdateExpression: "SET #s = :a, reviewedBy = :r, reviewedAt = :t, updatedAt = :t",
                ConditionExpression: "#s = :p",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":a": "APPROVED", ":p": "PENDING_APPROVAL", ":r": reviewer, ":t": stamp },
              },
            },
            {
              // The public revision switches to exactly the reviewed content, in the same transaction that approves it.
              Update: {
                TableName: this.storiesTable,
                Key: { userId: submission.submittedBy, hauntId: submission.storyId },
                UpdateExpression: "SET #st = :pub, publishedKey = :pk, publishedAt = :t, updatedAt = :t, publicStory = :public",
                ConditionExpression: "#v = :v",
                ExpressionAttributeNames: { "#v": "version", "#st": "status" },
                ExpressionAttributeValues: {
                  ":v": submission.version,
                  ":pub": "published",
                  ":pk": "published",
                  ":t": stamp,
                  ":public": { story: story.story, version: story.version, approvedAt: stamp },
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const latest = await this.get(submissionId);
      if (latest?.status === "APPROVED") return latest;
      throw new ApprovalError("stale", "The submission changed while you were reviewing it. Reload and try again.");
    }
    return { ...submission, status: "APPROVED", reviewedBy: reviewer, reviewedAt: stamp, updatedAt: stamp };
  }

  /** Rejects a pending submission with a reason. The story stays a private draft that its creator can edit and resubmit. */
  async reject(reviewer: string, submissionId: string, reason: string): Promise<SubmissionRecord> {
    const text = reason.trim();
    if (!text) throw new ApprovalError("invalid", "Give a reason for rejecting this story.");
    if (text.length > REASON_LIMIT) throw new ApprovalError("invalid", `The reason must be ${REASON_LIMIT} characters or fewer.`);
    const submission = await this.get(submissionId);
    if (!submission) throw new ApprovalError("not_found", "No such submission.");
    if (submission.submittedBy === reviewer) throw new ApprovalError("forbidden", "You can't review your own story.");
    if (submission.status === "REJECTED") return submission;
    if (submission.status !== "PENDING_APPROVAL") throw new ApprovalError("conflict", `This submission is ${submission.status.toLowerCase().replace("_", " ")}.`);

    const stamp = this.now();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { submissionId },
          UpdateExpression: "SET #s = :rej, reviewedBy = :r, reviewedAt = :t, rejectionReason = :why, updatedAt = :t",
          ConditionExpression: "#s = :p",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":rej": "REJECTED", ":p": "PENDING_APPROVAL", ":r": reviewer, ":t": stamp, ":why": text },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      throw new ApprovalError("conflict", "This submission was already reviewed. Reload to see the decision.");
    }
    return { ...submission, status: "REJECTED", reviewedBy: reviewer, reviewedAt: stamp, rejectionReason: text, updatedAt: stamp };
  }
}

/** A story as the review screen shows it: the record a reviewer needs, with the creator's account identifiers left out. */
export function reviewSummary(submission: SubmissionRecord, story: UserStoryRecord | undefined) {
  return {
    ...submission,
    title: story?.story.title ?? "",
    author: story?.story.author ?? "",
    genre: story?.story.genre ?? "",
    coverUrl: story?.story.coverUrl ?? "",
    /** False when the story has changed since this submission, so it can no longer be approved. */
    current: story !== undefined && story.version === submission.version,
  };
}
