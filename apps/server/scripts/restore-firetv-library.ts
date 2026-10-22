/**
 * Restores the Fire TV library stories (every library# record in haunt-stories) from the canonical fixture
 * apps/server/fixtures/firetv-library-stories.json into DynamoDB Local, and only there.
 *
 *   npm run restore:firetv-library                       dry run (default): validates, reads, reports; writes nothing
 *   npm run restore:firetv-library -- --apply            writes records that are missing; differing records are skipped
 *   npm run restore:firetv-library -- --apply --replace  also overwrites records that differ, after a backup of all
 *                                                         existing library records is written outside the repository
 *
 * Safeguards: the endpoint is fixed to http://localhost:8001 and any other AWS_ENDPOINT_URL_DYNAMODB fails the run; AWS_PROFILE
 * is refused; credentials must come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (any value works for DynamoDB Local).
 * Only the 22 library# ids in the fixture are read or written. Progress, likes, play counts, users, and OTP items are never
 * touched. The table is never created, deleted, or scanned for writes. Story text is never printed: reports give ids,
 * counts, indices, and field names.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ENDPOINT = "http://localhost:8001";
const REGION = "us-east-1";
const TABLE = "haunt-stories";
const FIXTURE = fileURLToPath(new URL("../fixtures/firetv-library-stories.json", import.meta.url));
const MOODS = new Set(["calm", "uneasy", "threat", "suspense", "ending", "exploration"]);
const EXPECTED_IDS = [
  ...Array.from({ length: 20 }, (_, i) => `library#haunt-original-${String(i + 1).padStart(2, "0")}`),
  "library#test-lighthouse",
  "library#test-ghost-house",
];

interface Segment {
  sceneIndex: number;
  narration: string;
  mood: string;
  soundCues?: string[];
  visualPrompt?: string;
  choices?: { prompt: string; options: { label: string; next: number }[] };
  ending?: boolean;
}
interface Story {
  id: string;
  entry: Record<string, unknown> & { episode: Record<string, unknown> & { storyId: string; segments: Segment[] } };
}
interface Fixture {
  stories: Story[];
}
export interface GraphReport {
  segments: number;
  decisions: { index: number; options: number; targets: number[] }[];
  endings: number[];
  unreachable: number[];
  problems: string[];
}

/**
 * Checks one story's segments and walks its branch graph from segment 0. Problems are collected rather than thrown, so
 * every story gets a full report. Segment indices are array positions: sceneIndex 0 is the first segment.
 */
export function analyzeGraph(segments: Segment[]): GraphReport {
  const problems: string[] = [];
  const decisions: GraphReport["decisions"] = [];
  segments.forEach((segment, i) => {
    // sceneIndex is zero-based and matches the segment's array position, as the story engine's scene index does.
    if (segment.sceneIndex !== i) problems.push(`segment ${i} has sceneIndex ${segment.sceneIndex} (expected ${i})`);
    if (!MOODS.has(segment.mood)) problems.push(`segment ${i} has an unknown mood`);
    if (segment.narration.trim() === "") problems.push(`segment ${i} has no narration`);
    if (/^part\s+\d+/i.test(segment.narration.trim())) problems.push(`segment ${i} narration starts with a part label`);
    if (segment.choices) {
      const targets = segment.choices.options.map((option) => option.next);
      decisions.push({ index: i, options: segment.choices.options.length, targets });
      if (segment.choices.options.length < 2) problems.push(`decision ${i} has fewer than two options`);
      if (new Set(targets).size !== targets.length) problems.push(`decision ${i} has duplicate targets`);
      for (const option of segment.choices.options) {
        if (option.label.trim() === "") problems.push(`decision ${i} has an empty label`);
        if (!Number.isInteger(option.next) || option.next < 0 || option.next >= segments.length) {
          problems.push(`decision ${i} points to missing segment ${option.next}`);
        }
      }
    }
  });
  const reached = new Set<number>();
  const endings = new Set<number>();
  const onPath = new Set<number>();
  const visit = (at: number) => {
    if (at >= segments.length) return problems.push(`a path runs past the last segment (${at})`);
    if (onPath.has(at)) return problems.push(`cycle through segment ${at}`);
    if (reached.has(at)) return;
    reached.add(at);
    onPath.add(at);
    const segment = segments[at]!;
    if (segment.ending) endings.add(at);
    else if (segment.choices) for (const option of segment.choices.options) visit(option.next);
    else visit(at + 1);
    onPath.delete(at);
  };
  if (segments.length) visit(0);
  if (endings.size < 2) problems.push(`only ${endings.size} reachable ending(s)`);
  return {
    segments: segments.length,
    decisions,
    endings: [...endings].sort((a, b) => a - b),
    unreachable: segments.map((_, i) => i).filter((i) => !reached.has(i)),
    problems,
  };
}

const canonical = (value: unknown) => stable(value);

/** Stable serialisation: object keys sorted, arrays in order. Used for comparing records. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** Field names that differ between two entries, by path. Never the text itself. */
export function differingFields(canonical: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(canonical), ...Object.keys(current)]);
  for (const key of [...keys].sort()) {
    if (key === "episode") {
      const a = canonical.episode as Record<string, unknown>;
      const b = current.episode as Record<string, unknown> | undefined;
      if (!b) {
        out.push("episode (missing)");
        continue;
      }
      for (const sub of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (sub === "segments") {
          const sa = a.segments as Segment[];
          const sb = b.segments as Segment[];
          if (sa.length !== sb.length) out.push(`episode.segments (count ${sb.length} vs ${sa.length})`);
          sa.forEach((seg, i) => {
            if (!sb[i]) return;
            for (const f of [...new Set([...Object.keys(seg), ...Object.keys(sb[i]!)])].sort()) {
              if (stable(seg[f as keyof Segment]) !== stable(sb[i]![f as keyof Segment])) out.push(`episode.segments[${i}].${f}`);
            }
          });
        } else if (stable(a[sub]) !== stable(b[sub])) out.push(`episode.${sub}`);
      }
    } else if (stable(canonical[key]) !== stable(current[key])) out.push(key);
  }
  return out;
}

function requireLocalEnvironment() {
  if (process.env.AWS_ENDPOINT_URL_DYNAMODB && process.env.AWS_ENDPOINT_URL_DYNAMODB !== ENDPOINT) {
    throw new Error(`AWS_ENDPOINT_URL_DYNAMODB is set to something other than ${ENDPOINT}. Unset it; this script only talks to DynamoDB Local.`);
  }
  if (process.env.AWS_PROFILE) throw new Error("AWS_PROFILE is set. Unset it; this script never uses a profile.");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (any value works for DynamoDB Local).");
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const replace = process.argv.includes("--replace");
  if (replace && !apply) throw new Error("--replace only works together with --apply.");
  requireLocalEnvironment();

  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const ids = fixture.stories.map((s) => s.id);
  if (ids.length !== 22 || new Set(ids).size !== 22) throw new Error("The fixture must contain exactly 22 unique stories.");
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...EXPECTED_IDS].sort())) {
    throw new Error("The fixture's story ids are not the 22 library ids this script expects.");
  }

  // Validate everything before any read-for-write or write.
  let invalid = 0;
  console.log("Branching validation (from the fixture):");
  for (const story of fixture.stories) {
    const g = analyzeGraph(story.entry.episode.segments);
    const branching = g.decisions.length > 0 && g.endings.length >= 2 && g.problems.length === 0;
    if (story.entry.episode.storyId !== story.id.slice("library#".length)) {
      g.problems.push("episode.storyId does not match the record id");
    }
    if (g.problems.length) invalid += 1;
    console.log(
      `  ${story.id}: ${g.segments} segments; decisions ${g.decisions.map((d) => `${d.index}(${d.options} options)`).join(", ") || "none"}; ` +
        `endings ${g.endings.join(", ") || "none"}; unreachable ${g.unreachable.join(", ") || "none"}; ` +
        `${branching ? "branches" : "NOT a valid branching story"}${g.problems.length ? `; problems: ${g.problems.join("; ")}` : ""}`,
    );
  }
  // Validation problems never stop the dry run (it still shows the comparison), but they block --apply entirely.
  if (invalid && apply) throw new Error(`${invalid} story(ies) failed validation. Nothing was written.`);
  if (invalid) console.log(`\n${invalid} story(ies) have validation problems. The dry run continues; --apply is blocked until they are fixed.`);

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: ENDPOINT, region: REGION }));
  const current = new Map<string, Record<string, unknown> | undefined>();
  for (const story of fixture.stories) {
    const { Item } = await client.send(new GetCommand({ TableName: TABLE, Key: { id: story.id }, ConsistentRead: true }));
    current.set(story.id, Item?.entry as Record<string, unknown> | undefined);
  }

  const plan = fixture.stories.map((story) => {
    const existing = current.get(story.id);
    if (!existing) return { story, action: "create" as const, fields: [] as string[] };
    const fields = differingFields(story.entry, existing);
    return { story, action: fields.length ? ("replace" as const) : ("same" as const), fields };
  });

  console.log("\nComparison with DynamoDB Local (" + ENDPOINT + "):");
  for (const p of plan) {
    const detail = p.action === "replace" ? `: differs in ${p.fields.join(", ")}` : "";
    console.log(`  ${p.story.id}: ${p.action === "create" ? "missing, would create" : p.action === "same" ? "identical" : `differs${apply ? (replace ? ", replacing" : ", skipped (needs --replace)") : ", would skip without --replace"}`}${detail}`);
  }
  const creates = plan.filter((p) => p.action === "create");
  const replaces = plan.filter((p) => p.action === "replace");
  console.log(`\nSummary: ${creates.length} to create, ${replaces.length} differing, ${plan.length - creates.length - replaces.length} identical.`);

  if (!apply) {
    console.log("Dry run only. Nothing was written. Add --apply to create missing records.");
    return;
  }

  if (replace && replaces.length) {
    // Backup first, and verified: the file must read back with every existing record exactly as it was read. Any failure here
    // throws before the first write below.
    const backupDir = join(homedir(), "haunt-restore-backups");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `firetv-library-${stamp}.json`);
    const present = fixture.stories.filter((s) => current.get(s.id) !== undefined);
    const absent = fixture.stories.filter((s) => current.get(s.id) === undefined).map((s) => s.id);
    const backup = { taken: stamp, endpoint: ENDPOINT, table: TABLE, absent, records: present.map((s) => ({ id: s.id, entry: current.get(s.id) })) };
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
    const reread = JSON.parse(readFileSync(backupPath, "utf8")) as typeof backup;
    const verified =
      reread.records.length === present.length &&
      reread.records.every((r, i) => r.id === present[i]!.id && canonical(r.entry) === canonical(current.get(present[i]!.id)));
    if (!verified) throw new Error(`The backup at ${backupPath} could not be verified. Nothing was written.`);
    console.log(`Backup of ${present.length} existing library record(s) written and verified at ${backupPath} (outside the repository).`);
    if (absent.length) console.log(`  Absent from the table before the restore: ${absent.join(", ")}`);
  }

  for (const p of plan) {
    if (p.action === "create") {
      await client.send(new PutCommand({ TableName: TABLE, Item: { id: p.story.id, entry: p.story.entry }, ConditionExpression: "attribute_not_exists(id)" }));
    } else if (p.action === "replace" && replace) {
      await client.send(new PutCommand({ TableName: TABLE, Item: { id: p.story.id, entry: p.story.entry } }));
    }
  }

  console.log("\nRead-back:");
  let mismatched = 0;
  for (const story of fixture.stories) {
    const { Item } = await client.send(new GetCommand({ TableName: TABLE, Key: { id: story.id }, ConsistentRead: true }));
    const fields = Item ? differingFields(story.entry, Item.entry as Record<string, unknown>) : ["(missing)"];
    if (fields.length) mismatched += 1;
    console.log(`  ${story.id}: ${fields.length ? `differs in ${fields.join(", ")}` : "matches the fixture"}`);
  }
  // A mismatch after writing is a failed run, not a warning.
  if (mismatched) throw new Error(`${mismatched} record(s) do not match the fixture after the write.`);
}

main().catch((error: Error) => {
  console.error(`restore failed: ${error.message}`);
  process.exitCode = 1;
});
