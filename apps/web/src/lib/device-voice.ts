/**
 * Voice navigation for the Haunt app on the simulated Echo Show: open a tab, play a story, continue one of yours.
 * Each command must be the whole sentence, so the same words inside a story idea or an answer never trigger it.
 * Creating a story by voice is lib/create-voice.ts.
 */

export type DeviceTab = "home" | "community" | "mine" | "create" | "profile";

/** Which story: a position in the list on screen (0-based, -1 = last), or words from its title. */
export type StoryPick = { index: number } | { title: string };

export type NavCommand =
  | { kind: "tab"; tab: DeviceTab }
  | { kind: "play"; pick: StoryPick }
  | { kind: "continue"; pick: StoryPick };

const ORDINALS: Record<string, number> = {
  first: 0, one: 0, "1": 0, "1st": 0,
  second: 1, two: 1, "2": 1, "2nd": 1,
  third: 2, three: 2, "3": 2, "3rd": 2,
  fourth: 3, four: 3, "4": 3, "4th": 3,
  fifth: 4, five: 4, "5": 4, "5th": 4,
  last: -1, latest: -1,
};

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |ok |okay |alexa |hey )+/, "")
    .replace(/( please| now)$/, "");
}

// "home", "go home", "go to home", "go back home", "take me home", "back to the home screen", "go back", "exit".
const HOME =
  /^(?:(?:go|going|take me|bring me|get me|head|navigate|switch|return|back|go back|open|show)(?: (?:back|me))?(?: to| into)? )?(?:the )?home(?: screen| page| tab)?$|^(?:go back|exit|close (?:the )?story|leave (?:the )?story)$/;

/** True for any way of saying "go home". */
export function isGoHome(spoken: string): boolean {
  return HOME.test(clean(spoken));
}

const TABS: { tab: DeviceTab; pattern: RegExp }[] = [
  { tab: "home", pattern: HOME },
  { tab: "community", pattern: /^(go to |open |show( me)? |browse )?(the )?(community|library|community stories|shared stories)( tab| page)?$/ },
  { tab: "mine", pattern: /^(go to |open |show( me)? )?(my|mine)( own)? stories( tab| page)?$/ },
  { tab: "create", pattern: /^(go to |open )(the )?create( tab| page| screen)?$|^create( tab| page| screen)$/ },
  { tab: "profile", pattern: /^(go to |open |show( me)? )?(my |the )?(profile|account)( tab| page)?$/ },
];

/** "the first one", "two", "last story" → a position; anything else → title words. */
function pickFrom(rest: string): StoryPick | null {
  const words = rest.replace(/^(the|my)\s+/, "").replace(/\s+(one|story)$/, "").trim();
  if (!words) return null;
  if (words in ORDINALS) return { index: ORDINALS[words]! };
  if (/^(last|latest|most recent)( story)?$/.test(words)) return { index: -1 };
  return { title: words };
}

export function parseNavigation(spoken: string): NavCommand | null {
  const text = clean(spoken);
  if (!text) return null;
  for (const { tab, pattern } of TABS) if (pattern.test(text)) return { kind: "tab", tab };

  const resume = text.match(/^(?:continue|resume|keep going with|carry on with|pick up)(?: with)?(?: my)?\s+(.+)$/);
  if (resume) {
    const pick = pickFrom(resume[1]!);
    if (pick) return { kind: "continue", pick };
  }

  const play = text.match(/^(?:play|listen to|open|start playing)\s+(.+)$/);
  if (play) {
    const pick = pickFrom(play[1]!);
    if (pick) return { kind: "play", pick };
  }
  return null;
}

/** Finds the story a pick refers to in a list (newest or top first). */
export function pickStory<T extends { title: string }>(list: readonly T[], pick: StoryPick): T | undefined {
  if (!list.length) return undefined;
  if ("index" in pick) return pick.index < 0 ? list[list.length - 1] : list[pick.index];
  const wanted = pick.title.replace(/^the\s+/, "");
  const norm = (s: string) => clean(s).replace(/^the\s+/, "");
  return (
    list.find((item) => norm(item.title) === wanted) ??
    list.find((item) => norm(item.title).includes(wanted) || wanted.includes(norm(item.title)))
  );
}
