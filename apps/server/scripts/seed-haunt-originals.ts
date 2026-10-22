/**
 * Seeds the Haunt Original stories into the live library table. Story text is read from stdin
 * only and is never written to disk by this script. Each record gets a stable id and is written
 * with a conditional put: a story that already exists is skipped, never overwritten.
 *
 *   cat stories.json | AWS_PROFILE=haunt npx tsx scripts/seed-haunt-originals.ts              # dry run, reads only
 *   cat stories.json | AWS_PROFILE=haunt npx tsx scripts/seed-haunt-originals.ts --apply      # writes
 *
 * stories.json is an array of 20 stories: { id, title, genre, subgenre, synopsis, ending,
 * segments: [{ mood, narration }] }. Story contents are never printed.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "../src/config.ts";
import { mainPath } from "@firetales/core";
import { DynamoLibrary, type LibraryEntry } from "../src/library.ts";

const EXPECTED = 20;
const MOODS = new Set(["calm", "uneasy", "suspense", "exploration", "threat", "revelation", "ending"]);
const WORDS_PER_MINUTE = 150;
const ID = /^haunt-original-\d{2}$/;

interface Input {
  id: string;
  title: string;
  genre: string;
  subgenre: string;
  synopsis: string;
  ending: string;
  segments: InputSegment[];
}

/** One part. Branching parts add `choices` (options name part indexes), `next`, and `ending`. */
interface InputSegment {
  mood: string;
  narration: string;
  choices?: { prompt: string; options: { label: string; next: number }[] };
  next?: number;
  ending?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function validate(stories: Input[]): void {
  if (!Array.isArray(stories) || stories.length !== EXPECTED) throw new Error(`Expected ${EXPECTED} stories.`);
  const ids = new Set<string>();
  for (const s of stories) {
    if (!ID.test(s.id)) throw new Error(`Bad id: ${s.id}`);
    if (ids.has(s.id)) throw new Error(`Duplicate id in input: ${s.id}`);
    ids.add(s.id);
    if (!s.title || !s.synopsis || !s.ending || !s.genre || !s.subgenre) throw new Error(`${s.id}: missing a required field.`);
    if (!Array.isArray(s.segments) || s.segments.length < 4) throw new Error(`${s.id}: needs at least four segments.`);
    for (const seg of s.segments) {
      if (!MOODS.has(seg.mood)) throw new Error(`${s.id}: unknown mood "${seg.mood}".`);
      if (!seg.narration?.trim()) throw new Error(`${s.id}: empty narration.`);
    }
    // Every target must be a real part, and the main storyline (first option of each choice) must reach an ending.
    const inRange = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < s.segments.length;
    s.segments.forEach((seg, i) => {
      if (seg.next !== undefined && !inRange(seg.next)) throw new Error(`${s.id}: part ${i} points to a missing part.`);
      for (const option of seg.choices?.options ?? []) {
        if (!inRange(option.next)) throw new Error(`${s.id}: a choice in part ${i} points to a missing part.`);
      }
    });
    if (!mainPath(s.segments).some((i) => s.segments[i]!.ending)) throw new Error(`${s.id}: the main storyline has no ending.`);
  }
}

/** The library entry for one story, in the same shape the existing library stores. */
function toEntry(s: Input, publishedAt: string): LibraryEntry {
  const narrations = s.segments.map((seg) => seg.narration.trim());
  // The script and length describe the main storyline, the path "Listen without choices" plays.
  const script = mainPath(s.segments)
    .map((i) => narrations[i])
    .join("\n\n");
  const wordCount = script.split(/\s+/).filter(Boolean).length;
  return {
    episode: {
      storyId: s.id,
      title: s.title,
      premise: s.synopsis,
      language: "en",
      // Legacy: this script writes a one-based sceneIndex (i + 1). The library's canonical convention is zero-based, by array
      // position (see restore-firetv-library.ts), and the canonical copy of these stories is fixtures/firetv-library-stories.json.
      // Do not run this script to restore stories; it is kept for the record of how the originals were first written.
      segments: narrations.map((narration, i) => ({
        sceneIndex: i + 1,
        narration,
        mood: s.segments[i]!.mood as LibraryEntry["episode"]["segments"][number]["mood"],
        soundCues: [],
        visualPrompt: "",
        ...(s.segments[i]!.choices ? { choices: s.segments[i]!.choices } : {}),
        ...(s.segments[i]!.next !== undefined ? { next: s.segments[i]!.next } : {}),
        ...(s.segments[i]!.ending ? { ending: true } : {}),
      })),
      script,
      wordCount,
      estimatedMinutes: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),
    },
    creator: "Haunt Team",
    summary: s.synopsis,
    publishedAt,
    source: "HAUNT_ORIGINAL",
    genre: s.genre,
    subgenre: s.subgenre,
    ending: s.ending,
  };
}

const apply = process.argv.includes("--apply");
const stories = JSON.parse(await readStdin()) as Input[];
validate(stories);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion, maxAttempts: 4 }), {
  marshallOptions: { removeUndefinedValues: true },
});
const library = new DynamoLibrary(client, config.table);
const publishedAt = new Date().toISOString();

console.log(`${apply ? "Writing" : "Dry run (reads only)"}: ${stories.length} stories to "${config.table}" in ${config.awsRegion}`);
let inserted = 0;
let skipped = 0;
for (const s of stories) {
  const entry = toEntry(s, publishedAt);
  const key = `library#${s.id}`;
  if (!apply) {
    const { Item } = await client.send(new GetCommand({ TableName: config.table, Key: { id: key } }));
    const state = Item ? "already exists, would skip" : "new, would insert";
    console.log(`  ${key}: ${state} (${entry.episode.estimatedMinutes} min, ${entry.episode.wordCount} words)`);
    continue;
  }
  const wrote = await library.putIfAbsent(entry);
  if (wrote) inserted++;
  else skipped++;
  console.log(`  ${key}: ${wrote ? "inserted" : "skipped (already exists)"}`);
}
if (apply) console.log(JSON.stringify({ inserted, skipped }));
else console.log("Nothing was written. Re-run with --apply to insert.");
