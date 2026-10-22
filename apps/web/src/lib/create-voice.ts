/**
 * Creating a story by voice on the simulated Echo Show. The Create form's options are exactly the MCP start_story
 * inputs (apps/server/src/mcp.ts); this turns what the listener says into those fields.
 *
 * "Make a short, terrifying cosmic horror story in Hindi about a lighthouse that lights itself, and start it"
 *   → { subgenre: "cosmic", length: "short", intensity: "terrifying", language: "hi",
 *       idea: "a lighthouse that lights itself", action: "generate" }
 */

// Sub-genre ids are packages/firetales/src/subgenres.ts; names and art match the Fire TV Create screen.
export const SUBGENRES = [
  { id: "paranormal", name: "Paranormal", art: "/art/asylum.svg", say: ["paranormal", "supernatural"] },
  { id: "ghost", name: "Ghost Story", art: "/art/hallway.svg", say: ["ghost story", "ghost", "spirit"] },
  { id: "haunted-house", name: "Haunted House", art: "/art/ashford-house.svg", say: ["haunted house", "haunted"] },
  { id: "possession", name: "Possession", art: "/art/possession.svg", say: ["possession", "possessed", "demon"] },
  { id: "psychological", name: "Psychological", art: "/art/psychological.svg", say: ["psychological", "mind bending", "psycho"] },
  { id: "folk", name: "Folk Horror", art: "/art/village.svg", say: ["folk horror", "folk"] },
  { id: "cosmic", name: "Cosmic Horror", art: "/art/cosmic.svg", say: ["cosmic horror", "cosmic", "lovecraft"] },
  { id: "slasher", name: "Slasher", art: "/art/cabin.svg", say: ["slasher", "killer"] },
  { id: "gothic", name: "Gothic", art: "/art/gothic.svg", say: ["gothic"] },
  { id: "creature", name: "Creature Feature", art: "/art/forest.svg", say: ["creature feature", "creature", "monster"] },
  { id: "cult", name: "Cult", art: "/art/cult.svg", say: ["cult"] },
  { id: "survival", name: "Survival", art: "/art/ship.svg", say: ["survival", "survive"] },
] as const;

export const LENGTHS = [
  { id: "short", name: "Short", detail: "About 4 turns", say: ["short", "quick", "brief"] },
  { id: "medium", name: "Medium", detail: "About 6 turns", say: ["medium", "normal", "standard", "regular"] },
  { id: "long", name: "Long", detail: "About 8 turns", say: ["long", "epic", "longer"] },
] as const;

// Checked in this order, so "very scary" is terrifying, not scary.
export const FEAR = [
  { id: "terrifying", name: "Terrifying", detail: "Intense, never graphic", say: ["terrifying", "very scary", "really scary", "super scary", "intense", "extreme", "horrifying"] },
  { id: "eerie", name: "Eerie", detail: "Creepy, gentle", say: ["eerie", "creepy", "gentle", "mild", "not too scary", "a little scary", "spooky"] },
  { id: "scary", name: "Scary", detail: "The default", say: ["scary", "frightening"] },
] as const;

export const LANGUAGES = [
  { code: "en", label: "English", say: ["english"] },
  { code: "hi", label: "हिन्दी · Hindi", say: ["hindi"] },
  { code: "ta", label: "தமிழ் · Tamil", say: ["tamil"] },
  { code: "te", label: "తెలుగు · Telugu", say: ["telugu"] },
  { code: "kn", label: "ಕನ್ನಡ · Kannada", say: ["kannada"] },
  { code: "ml", label: "മലയാളം · Malayalam", say: ["malayalam"] },
  { code: "mr", label: "मराठी · Marathi", say: ["marathi"] },
  { code: "bn", label: "বাংলা · Bengali", say: ["bengali", "bangla"] },
  { code: "es", label: "Español · Spanish", say: ["spanish", "espanol"] },
  { code: "fr", label: "Français · French", say: ["french", "francais"] },
] as const;

export type SubgenreId = (typeof SUBGENRES)[number]["id"];
export type LengthId = (typeof LENGTHS)[number]["id"];
export type FearId = (typeof FEAR)[number]["id"];
export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export interface CreateForm {
  subgenre: SubgenreId;
  length: LengthId;
  intensity: FearId;
  language: LanguageCode;
  idea: string;
}

export const DEFAULT_FORM: CreateForm = { subgenre: "ghost", length: "medium", intensity: "scary", language: "en", idea: "" };

export interface CreateCommand {
  /** The fields this utterance sets. An empty idea ("" ) means "clear my idea". */
  fields: Partial<CreateForm>;
  /** generate: start the story now. open: go to the Create screen. */
  action: "generate" | "open" | null;
}

// Only at the end of what was said ("…, and start it"), so the same words inside an idea don't start the story.
const GENERATE =
  / (?:and |then |now |ok |okay )?(?:generate(?: it| the story| my story)?|create it|start(?: it| the story| my story| now)?|begin(?: the story)?|let'?s go|go ahead|do it|i'?m ready)(?: now| please)? $/;
const OPEN = /\b(create|make|design|build|write|new)\b.*\bstory\b|\bcreate (a|my|your) own\b|\bnew story\b/;
const CLEAR_IDEA = /\b(no idea|clear (the |my )?idea|remove (the |my )?idea|without an idea|any idea is fine)\b/;
// "about …", "where …", "my idea is …", "the idea is …": the rest of the sentence is the listener's idea.
const IDEA = /\b(?:my idea is|the idea is|idea is|idea:|about|where|in which|featuring)\s+(.+)$/;

function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function has(text: string, phrase: string): boolean {
  return text.includes(` ${phrase} `);
}

function firstMatch<T extends { say: readonly string[] }>(text: string, options: readonly T[]): T | undefined {
  return options.find((option) => option.say.some((phrase) => has(text, phrase)));
}

/** Reads one spoken sentence into Create form fields and an action. Unknown words are ignored. */
export function parseCreateCommand(spoken: string): CreateCommand {
  let text = words(spoken);
  const fields: Partial<CreateForm> = {};
  let action: CreateCommand["action"] = null;

  // Actions first, then strip them so "start it" isn't read as part of an idea.
  if (GENERATE.test(text)) {
    action = "generate";
    text = text.replace(GENERATE, " ");
  }
  if (CLEAR_IDEA.test(text)) {
    fields.idea = "";
    text = text.replace(CLEAR_IDEA, " ");
  }

  // Language: "in Hindi", "Hindi language" or just "Hindi". Taken out before the idea, so "about X in Hindi" works.
  const language = firstMatch(text, LANGUAGES);
  if (language) {
    fields.language = language.code;
    for (const phrase of language.say) text = text.replace(new RegExp(`( in)? ${phrase}( language)? `, "g"), " ");
  }

  // The idea is everything after "about …", so the words in it can't set other fields ("about a long night").
  const idea = text.match(IDEA);
  if (idea && fields.idea === undefined) {
    const value = idea[1]!.replace(/\b(and|please)\s*$/, "").trim();
    if (value) fields.idea = value;
    text = `${text.slice(0, idea.index)} `;
  }

  const subgenre = firstMatch(text, SUBGENRES);
  if (subgenre) fields.subgenre = subgenre.id;
  const length = firstMatch(text, LENGTHS);
  if (length) fields.length = length.id;
  const fear = firstMatch(text, FEAR);
  if (fear) fields.intensity = fear.id;

  if (!action && OPEN.test(text)) action = "open";
  return { fields, action };
}

/** What changed, in words, for the on-screen "heard" line. Empty when nothing was recognised. */
export function describeFields(fields: Partial<CreateForm>): string[] {
  const out: string[] = [];
  if (fields.subgenre) out.push(SUBGENRES.find((s) => s.id === fields.subgenre)!.name);
  if (fields.length) out.push(`${LENGTHS.find((l) => l.id === fields.length)!.name} length`);
  if (fields.intensity) out.push(FEAR.find((f) => f.id === fields.intensity)!.name);
  if (fields.language) out.push(LANGUAGES.find((l) => l.code === fields.language)!.label.split(" · ").pop()!);
  if (fields.idea !== undefined) out.push(fields.idea ? `idea: “${fields.idea}”` : "idea cleared");
  return out;
}

/** The start_story premise: the listener's idea, or one built from the sub-genre when they gave none. */
export function premiseFor(form: CreateForm): string {
  const kind = SUBGENRES.find((s) => s.id === form.subgenre)!.name.toLowerCase().replace(/ (story|horror|feature)$/, "");
  return form.idea.trim() || `A ${kind} horror story.`;
}
