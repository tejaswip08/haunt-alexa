/**
 * The spoken menus of the Echo with no screen: what the listener can say, and what the device says back.
 * On the Echo Show the same choices are tabs; here every one of them is a sentence. Kept free of React so it can be tested.
 */

export type EchoCommand =
  | { kind: "menu" }
  | { kind: "community" }
  | { kind: "mine" }
  | { kind: "continue-last" }
  | { kind: "create" }
  | { kind: "sign-in" }
  | { kind: "sign-out" };

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |ok |okay |alexa |hey |um |uh |i want to |i'd like to |i would like to |let me |can i |can you )+/, "")
    .replace(/( please| now)$/, "");
}

/** Whole-sentence commands for the Echo's main menu. Anything longer goes to the story or the assistant. */
export function parseEchoCommand(spoken: string): EchoCommand | null {
  const text = clean(spoken);
  if (!text) return null;
  if (/^(?:help|menu|main menu|what can i say|what can i do|options|start over from the menu|go home|home|go back|back|exit|main page)$/.test(text)) return { kind: "menu" };
  if (/^(?:continue|resume|keep going with|pick up)(?: with)?(?: my)? (?:last|latest|most recent)(?: story)?$/.test(text)) return { kind: "continue-last" };
  if (/^(?:listen to |hear |play |open |show |browse )?(?:the )?(?:community|community stories|community story|library|shared stories|stories from (?:the )?community|other people's stories)$/.test(text))
    return { kind: "community" };
  if (/^(?:listen to |hear |play |open |continue |resume )?(?:my|mine|my own)(?: own)? (?:stories|story)$|^mine$|^my stories please$/.test(text)) return { kind: "mine" };
  if (/^(?:create|make|write|start)(?: a| me a| my own| a new| new)?(?: story| one)?$|^(?:new story|create one|create a story|make a story)$/.test(text)) return { kind: "create" };
  if (/^(?:sign|log) ?(?:me )?in(?: to haunt)?$/.test(text)) return { kind: "sign-in" };
  if (/^(?:sign|log) ?(?:me )?out$/.test(text)) return { kind: "sign-out" };
  return null;
}

export const WELCOME =
  "Welcome to Haunt. Would you like to listen to community stories, hear your own stories, or create a new one? You can say help at any time.";

export const MENU = "You can say: community stories, my stories, or create a story. Or continue my last story.";

export const CREATE_GUIDE =
  "Let's make a story. Say it all at once, like: a terrifying cosmic horror story in Hindi about a lighthouse. " +
  "Or one thing at a time: the kind of horror, like ghost, cosmic or haunted house. Your idea, starting with about. " +
  "Short, medium or long. Eerie, scary or terrifying. And the language. Say generate when you're ready.";

const NUMBERS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/** "There are 2 community stories. One: The Smiling House, by rajeshm. … Which one?" Reads at most `max`. */
export function listLine(intro: string, items: { title: string; detail?: string }[], max = 5): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, max);
  const more = items.length > max ? ` Those are the newest ${max}.` : "";
  const list = shown.map((item, i) => `${NUMBERS[i]}: ${item.title}${item.detail ? `, ${item.detail}` : ""}.`).join(" ");
  return `${intro} ${list}${more} Which one? Say a number or a title.`;
}

export const countLine = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;

/** One digit, from "8" or "eight". "eleven" is not one digit. */
function oneDigit(token: string): string | null {
  if (/^\d$/.test(token)) return token;
  const value = SMALL_NUMBERS[token];
  return value !== undefined && value < 10 ? String(value) : null;
}

/** A number smaller than `below`, starting at `index`. Used after "hundred". */
function takeSmaller(tokens: string[], index: number, below: number): { value: number; index: number } | null {
  const word = tokens[index];
  if (!word || word === "@" || word === ".") return null;
  const tens = TENS[word];
  if (tens !== undefined && tens < below) {
    const ones = SMALL_NUMBERS[tokens[index + 1] ?? ""];
    if (ones !== undefined && ones < 10) return { value: tens + ones, index: index + 1 };
    return { value: tens, index };
  }
  const small = SMALL_NUMBERS[word];
  if (small !== undefined && small < below) return { value: small, index };
  return null;
}

/**
 * Turns spoken numbers into the digits an email actually contains.
 * "eight hundred and eleven" and "eight eleven" and "8 1 1" all become 811.
 * "double 1" becomes 11. "@" and "." tokens are left in place.
 */
function foldSpokenNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!;
    if (word === "@" || word === ".") {
      out.push(word);
      continue;
    }
    if ((word === "double" || word === "triple") && tokens[i + 1]) {
      const digit = oneDigit(tokens[i + 1]!);
      if (digit) {
        out.push(digit.repeat(word === "double" ? 2 : 3));
        i += 1;
        continue;
      }
    }
    const small = SMALL_NUMBERS[word];
    if (small !== undefined && small < 10 && (tokens[i + 1] === "hundred" || tokens[i + 1] === "thousand")) {
      const scale = tokens[i + 1] === "hundred" ? 100 : 1000;
      let value = small * scale;
      i += 1;
      if (tokens[i + 1] === "and") i += 1;
      const rest = takeSmaller(tokens, i + 1, scale);
      if (rest) {
        value += rest.value;
        i = rest.index;
      }
      out.push(String(value));
      continue;
    }
    const tens = TENS[word];
    if (tens !== undefined) {
      const ones = SMALL_NUMBERS[tokens[i + 1] ?? ""];
      if (ones !== undefined && ones < 10) {
        out.push(String(tens + ones));
        i += 1;
      } else out.push(String(tens));
      continue;
    }
    if (small !== undefined) {
      out.push(String(small));
      continue;
    }
    if (word === "and") continue;
    out.push(word);
  }
  return out;
}

/**
 * An email said aloud. Understands "at" and "at the rate", "dot", and numbers said as words
 * ("p eight one one", "p eight hundred and eleven", "p 8 double 1") so tejaswip811@gmail.com
 * stays that address. Returns null when it isn't an email, so a code is never sent for a guess.
 */
export function parseSpokenEmail(spoken: string): string | null {
  let text = spoken
    .toLowerCase()
    .replace(/[^a-z0-9@._+\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:my |the )?e-?mail(?: address)?(?: is)? /, "")
    .replace(/^(?:it is|it's) /, "");
  if (!text) return null;
  const compact = text.replace(/ /g, "");
  if (text.includes("@") && EMAIL_SHAPE.test(compact)) return compact;

  text = text
    .replace(/\bat the rate of\b/g, "@")
    .replace(/\bat the rate\b/g, "@")
    .replace(/\battherate\b/g, "@")
    .replace(/\bat\b/g, "@")
    .replace(/\b(?:dot|period|point)\b/g, ".")
    .replace(/\bunderscore\b/g, "_")
    .replace(/\b(?:dash|hyphen)\b/g, "-")
    .replace(/\bgee mail\b/g, "gmail")
    .replace(/\bg mail\b/g, "gmail")
    .replace(/\bhot mail\b/g, "hotmail")
    .replace(/\bout look\b/g, "outlook")
    .replace(/\bi cloud\b/g, "icloud")
    .replace(/\bproton mail\b/g, "protonmail");

  const email = foldSpokenNumbers(text.split(" ").filter(Boolean)).join("");
  return EMAIL_SHAPE.test(email) ? email : null;
}

/**
 * Reads an address so a mixed name like tejaswip811 cannot be heard as a different number.
 * "t, e, j, a, s, w, i, p, 8, 1, 1, at gmail dot com".
 */
export function confirmEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return speakEmail(email);
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).replaceAll(".", " dot ");
  const spelled = local
    .split("")
    .map((character) => (character === "." ? "dot" : character === "_" ? "underscore" : character === "-" ? "dash" : character === "+" ? "plus" : character))
    .join(", ");
  return `${spelled}, at ${domain}`;
}

/** Digits of a one-time code: "one two three four five six seven eight" or "12345678". At most eight. */
export function parseSpokenCode(spoken: string): string | null {
  const text = spoken
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:my |the )?(?:sign ?in |one[- ]time )?code(?: is)? /, "")
    .replace(/^(?:it is|it's) /, "");
  if (!text) return null;
  const mapped = text.split(" ").map((part) => (/^\d+$/.test(part) ? part : DIGIT_WORDS[part]));
  if (mapped.some((part) => part === undefined)) return null;
  const code = mapped.join("");
  return code.length > 0 && code.length <= 8 ? code : null;
}

/** "tejaswi@mobil80.com" read aloud as "tejaswi at mobil80 dot com". */
export function speakEmail(email: string): string {
  return email.replaceAll("@", " at ").replaceAll(".", " dot ");
}

/** Reads a pairing code one character at a time, so it can be typed on a phone: "7, S, 3, 8, dash, K, C, 4, F". */
export function spellCode(code: string): string {
  return code
    .split("")
    .map((c) => (c === "-" ? "dash" : c))
    .join(", ");
}

/** "localhost:5173/activate" read aloud: "localhost colon 5173 slash activate". */
export function sayAddress(uri: string): string {
  return uri
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/:/g, " colon ")
    .replace(/\//g, " slash ")
    .replace(/\./g, " dot ");
}
