/**
 * Restores the two local test stories (Local Test: The Lamp at Gale Point, Local Test: The Quiet Hall) from the
 * canonical fixture into DynamoDB Local. Local only: the endpoint is fixed to localhost:8001, and the script refuses to
 * run against anything else. It writes only the two `library#` items named in the fixture. Progress, likes, play counts,
 * and every other story are never read or written.
 *
 *   npm run restore:local-tests                 dry run: reads the table and reports what would change
 *   npm run restore:local-tests -- --apply      writes, but only for stories that are absent from the table
 *   npm run restore:local-tests -- --apply --replace
 *                                               also overwrites those two items if they already exist
 *
 * Story text is printed by no part of this script; it reports ids, counts, and whether the stored record matches.
 * Credentials: DynamoDB Local accepts any values, so export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (for example
 * "local") in the shell. AWS_PROFILE is ignored.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ENDPOINT = "http://localhost:8001";
const REGION = "us-east-1";
const TABLE = "haunt-stories";
const FIXTURE = fileURLToPath(new URL("../fixtures/local-test-stories.json", import.meta.url));
const TEST_IDS = ["library#test-lighthouse", "library#test-ghost-house"];

interface Segment {
  sceneIndex: number;
  narration: string;
  mood: string;
  soundCues: string[];
  visualPrompt: string;
  choices?: { prompt: string; options: { label: string; next: number }[] };
  ending?: boolean;
}
interface FixtureStory {
  id: string;
  entry: Record<string, unknown> & { episode: { segments: Segment[]; storyId: string } };
}
interface Fixture {
  stories: FixtureStory[];
}

/** The branch graph must be sound before anything is written: every target exists, and at least two endings are reachable. */
export function checkGraph(segments: Segment[]): { endings: number[]; decisions: number[] } {
  const problems: string[] = [];
  segments.forEach((segment, i) => {
    if (segment.narration.trim() === "" || /^part\s+\d+/i.test(segment.narration.trim())) problems.push(`segment ${i} has no usable narration`);
    for (const option of segment.choices?.options ?? []) {
      if (!Number.isInteger(option.next) || option.next < 0 || option.next >= segments.length) problems.push(`segment ${i} points to a missing segment`);
      if (option.label.trim() === "") problems.push(`segment ${i} has an empty choice`);
    }
  });
  const endings = new Set<number>();
  const seen = new Set<number>();
  const walk = (at: number) => {
    if (at >= segments.length || seen.has(at)) return;
    seen.add(at);
    const segment = segments[at]!;
    if (segment.ending) return void endings.add(at);
    if (segment.choices) for (const option of segment.choices.options) walk(option.next);
    else walk(at + 1);
  };
  walk(0);
  if (endings.size < 2) problems.push(`only ${endings.size} ending(s) reachable`);
  if (problems.length) throw new Error(problems.join("; "));
  return {
    endings: [...endings].sort((a, b) => a - b),
    decisions: segments.flatMap((segment, i) => (segment.choices ? [i] : [])),
  };
}

const canonical = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());

async function main() {
  const apply = process.argv.includes("--apply");
  const replace = process.argv.includes("--replace");
  if (replace && !apply) throw new Error("--replace only works together with --apply.");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first (any value works for DynamoDB Local).");
  }

  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const wanted = fixture.stories.map((story) => story.id).sort();
  if (JSON.stringify(wanted) !== JSON.stringify([...TEST_IDS].sort())) throw new Error("The fixture must hold exactly the two test stories.");
  for (const story of fixture.stories) {
    const graph = checkGraph(story.entry.episode.segments);
    console.log(`${story.id}: ${story.entry.episode.segments.length} segments, decisions at ${graph.decisions.join(", ")}, endings ${graph.endings.join(", ")}`);
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: ENDPOINT, region: REGION }));
  for (const story of fixture.stories) {
    const { Item } = await client.send(new GetCommand({ TableName: TABLE, Key: { id: story.id }, ConsistentRead: true }));
    if (!Item) {
      console.log(`${story.id}: absent in DynamoDB Local${apply ? " (writing)" : " (would write)"}`);
      if (apply) {
        await client.send(new PutCommand({ TableName: TABLE, Item: story, ConditionExpression: "attribute_not_exists(id)" }));
      }
    } else if (canonical(Item.entry) === canonical(story.entry)) {
      console.log(`${story.id}: present and already matches the fixture (nothing to do)`);
    } else if (!apply) {
      console.log(`${story.id}: present and differs from the fixture (would ${replace ? "replace" : "skip without --replace"})`);
    } else if (replace) {
      console.log(`${story.id}: present and differs; replacing (--replace)`);
      await client.send(new PutCommand({ TableName: TABLE, Item: story }));
    } else {
      console.log(`${story.id}: present and differs; skipped (pass --replace to overwrite)`);
    }
  }

  if (apply) {
    for (const story of fixture.stories) {
      const { Item } = await client.send(new GetCommand({ TableName: TABLE, Key: { id: story.id }, ConsistentRead: true }));
      const ok = Item !== undefined && canonical(Item.entry) === canonical(story.entry);
      console.log(`${story.id}: read back ${ok ? "matches the fixture" : "does NOT match the fixture"}`);
    }
  }
}

main().catch((error: Error) => {
  console.error(`restore failed: ${error.message}`);
  process.exitCode = 1;
});
