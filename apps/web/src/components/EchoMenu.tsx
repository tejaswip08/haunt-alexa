import { useEffect, useRef, useState } from "react";
import { DEFAULT_FORM, describeFields, parseCreateCommand, premiseFor, type CreateForm } from "../lib/create-voice.ts";
import { device, useDevice } from "../lib/device.ts";
import { confirmEmail, countLine, CREATE_GUIDE, listLine, MENU, parseEchoCommand, parseSpokenCode, parseSpokenEmail, speakEmail, WELCOME } from "../lib/echo-menu.ts";
import { fetchMyStories, myStories, type SavedStory } from "../lib/my-stories.ts";
import { pickOption } from "../lib/play-mode.ts";
import { session, useSession } from "../lib/session.ts";

/**
 * The Echo with no screen, run entirely by voice: everything the Echo Show's tabs do, as spoken menus.
 * It greets the listener and offers community stories, their own stories, or creating one; reads lists aloud and takes a
 * number or a title; walks through Create field by field (or all at once); and signs in by asking for an email, sending
 * the one-time code only after that, then asking for the code. "Help", "menu" or "go home" bring the menu back at any
 * time. Anything it doesn't recognise goes on to the story or the assistant, exactly as before.
 */

interface CommunityItem {
  storyId: string;
  title: string;
  summary?: string;
  creator?: string;
  minutes?: number;
}

/** Where voice sign-in leads once it's done: the locked choice that asked for it, or the menu. */
type SignInNext = "create" | "community" | "menu";

type Step =
  | { kind: "menu" }
  | { kind: "community"; stories: CommunityItem[] }
  | { kind: "mine"; stories: SavedStory[] }
  | { kind: "create"; form: CreateForm }
  | { kind: "signin"; phase: "email" | "confirm" | "wait" | "code"; then: SignInNext; email: string; codeLength: number | null }
  /** A story is playing: only menu commands are taken here. */
  | { kind: "story" };

const HINTS: Record<Step["kind"], string[]> = {
  menu: ["Community stories", "My stories", "Create a story", "Continue my last story"],
  community: ["“Two”", "“The Smiling House”", "“Menu”"],
  mine: ["“One”", "“Continue the lighthouse”", "“Menu”"],
  create: ["“Cosmic horror”", "“About a lighthouse”", "“Long” · “Terrifying” · “In Hindi”", "“Generate”"],
  signin: ["name at example dot com", "“Menu” to stop"],
  story: ["“Pause” · “Resume” · “Next”", "Answer in your own words", "“Menu” for the main menu"],
};

export function EchoMenu() {
  const account = useSession();
  const [step, setStep] = useState<Step>({ kind: "menu" });
  const stepRef = useRef(step);
  stepRef.current = step;
  const accountRef = useRef(account);
  accountRef.current = account;
  const say = (text: string, listen = true) => void device.prompt(text, listen);

  /**
   * Voice sign-in, updated synchronously so a second utterance can't send another code while the first is in flight.
   * The code is requested only after an email has been heard.
   */
  const signIn = useRef<Extract<Step, { kind: "signin" }> | null>(null);
  useEffect(() => {
    const current = signIn.current;
    if (!current || account.status !== "signed-in") return;
    signIn.current = null;
    const who = account.user?.email ? ` as ${speakEmail(account.user.email)}` : "";
    if (current.then === "create") {
      setStep({ kind: "create", form: DEFAULT_FORM });
      say(`You're signed in${who}. ${CREATE_GUIDE}`);
    } else if (current.then === "community") {
      void openCommunity(`You're signed in${who}. `);
    } else {
      setStep({ kind: "menu" });
      say(`You're signed in${who}. ${MENU}`);
    }
  }, [account.status]);

  // Greet the listener when the Echo is switched on.
  useEffect(() => {
    device.reset();
    say(WELCOME);
    return () => device.reset();
  }, []);

  const goMenu = (line = MENU) => {
    signIn.current = null;
    device.reset();
    setStep({ kind: "menu" });
    say(line);
  };

  const openCommunity = async (before = "") => {
    if (locked()) return startSignIn("community", "To listen to community stories, sign in first.");
    try {
      const connection = await device.connect();
      const result = await connection.call("list_library", {}).result;
      const stories = ((result.structuredContent as { episodes?: CommunityItem[] } | undefined)?.episodes ?? []).slice(0, 8);
      if (!stories.length) return goMenu(`${before}There are no community stories yet. Say create a story to make one, or my stories.`);
      setStep({ kind: "community", stories });
      const intro = countLine(stories.length, "There is one community story.", "There are # community stories.");
      say(before + listLine(intro, stories.map((s) => ({ title: s.title, detail: s.creator ? `by ${s.creator}` : undefined }))));
    } catch {
      say("I couldn't reach the community stories just now. Try again in a moment, or say my stories.");
    }
  };

  /** The listener's stories from the server (list_my_stories), or the ones remembered in this browser if it can't answer. */
  const listMine = async (): Promise<SavedStory[]> => {
    const listed = await device.connect().then(fetchMyStories, () => null);
    return listed ?? myStories();
  };

  const openMine = async () => {
    const stories = (await listMine()).slice(0, 8);
    if (!stories.length) return goMenu("You don't have any stories yet. Say create a story to make your first one.");
    setStep({ kind: "mine", stories });
    const intro = countLine(stories.length, "You have one story.", "You have # stories.");
    say(listLine(intro, stories.map((s) => ({ title: s.title, detail: s.status === "completed" ? "finished" : `part ${s.sceneNumber} of ${s.totalScenes}` }))));
  };

  const playCommunity = (story: CommunityItem) => {
    setStep({ kind: "story" });
    void device.playEpisode(story.storyId, { title: story.title, summary: story.summary });
  };
  const resumeMine = (story: SavedStory) => {
    setStep({ kind: "story" });
    void device.resumeStory(story.storyId, story.title);
  };

  /** Community stories and creating need an account; a guest is asked to sign in first. My stories stay open. */
  const locked = () => accountRef.current.status !== "signed-in";
  const startSignIn = (then: SignInNext, reason = "") => {
    if (!accountRef.current.available)
      return say(`${reason ? `${reason} ` : ""}Sign-in isn't set up on this server, so that stays locked. You can still say my stories.`);
    if (accountRef.current.status === "signed-in") return say(`You're already signed in as ${speakEmail(accountRef.current.user?.email ?? "you")}.`);
    const next: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "email", then, email: "", codeLength: null };
    signIn.current = next;
    setStep(next);
    say(`${reason ? `${reason} ` : ""}What's your email address? Say letters and numbers one at a time, like a b c 8 1 1 at gmail dot com.`);
  };

  /** Repeats the address character by character. The code is sent only after the listener says yes. */
  const offerEmail = (email: string, then: SignInNext) => {
    const next: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "confirm", then, email, codeLength: null };
    signIn.current = next;
    setStep(next);
    say(`I heard ${confirmEmail(email)}. Say yes to send the code, or say the email again.`);
  };

  const sendCode = async (email: string, then: SignInNext) => {
    const current = signIn.current;
    if (!current || current.phase === "wait") return;
    const waiting: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "wait", then, email, codeLength: current.codeLength };
    signIn.current = waiting;
    setStep(waiting);
    const result = await session.start(email, "signin");
    if (signIn.current !== waiting) return;
    if (!result.ok) {
      const again: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "email", then, email: "", codeLength: null };
      signIn.current = again;
      setStep(again);
      say(`${result.error} What's your email address?`);
      return;
    }
    if (result.signedIn) return;
    const codeLength = result.codeLength === undefined ? 8 : result.codeLength;
    const asking: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "code", then, email, codeLength };
    signIn.current = asking;
    setStep(asking);
    const where = accountRef.current.testMode
      ? `The code for ${confirmEmail(email)} is in the server terminal.`
      : `I've emailed a code to ${confirmEmail(email)}.`;
    const length = codeLength ? ` It's ${codeLength} digits.` : "";
    say(`${where}${length} What's the code?`);
  };

  const checkCode = async (code: string) => {
    const current = signIn.current;
    if (!current || current.phase !== "code") return;
    const need = current.codeLength;
    if (need && code.length !== need) {
      say(`That was ${code.length} ${code.length === 1 ? "digit" : "digits"}. The code has ${need}. What's the code?`);
      return;
    }
    if (!need && (code.length < 6 || code.length > 8)) {
      say("Say the 6 to 8 digit code from your email.");
      return;
    }
    const waiting: Extract<Step, { kind: "signin" }> = { ...current, phase: "wait" };
    signIn.current = waiting;
    setStep(waiting);
    const result = await session.verify(code);
    if (signIn.current !== waiting) return;
    if (result.ok) return;
    if (result.restart) {
      const again: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "email", then: current.then, email: "", codeLength: null };
      signIn.current = again;
      setStep(again);
      say(`${result.error} What's your email address?`);
      return;
    }
    signIn.current = current;
    setStep(current);
    say(`${result.error} What's the code?`);
  };

  const openCreate = (form: CreateForm = DEFAULT_FORM, first?: string) => {
    if (locked()) return startSignIn("create", "To create a story, sign in first.");
    setStep({ kind: "create", form });
    say(first ?? CREATE_GUIDE);
  };

  const generate = (form: CreateForm) => {
    if (locked()) return startSignIn("create", "To create a story, sign in first.");
    setStep({ kind: "story" });
    void device.startStory({ premise: premiseFor(form), subgenre: form.subgenre, length: form.length, intensity: form.intensity, language: form.language });
  };

  // Everything said goes through here first (before the story and the assistant).
  useEffect(
    () =>
      device.setVoiceRouter((text) => {
        const current = stepRef.current;
        const command = parseEchoCommand(text);
        const create = parseCreateCommand(text);

        if (command?.kind === "menu") {
          goMenu();
          return true;
        }
        if (command?.kind === "sign-in") {
          startSignIn("menu");
          return true;
        }
        if (command?.kind === "sign-out") {
          void session.signOut();
          goMenu("You're signed out. " + MENU);
          return true;
        }
        // Sign-in is set immediately, before React re-renders, so the email isn't lost to the story.
        if (signIn.current) {
          const live = signIn.current;
          if (!live || live.phase === "wait") {
            say("One moment.", false);
            return true;
          }
          if (/(?:different|another|wrong) email|change (?:my )?email/i.test(text)) {
            const again: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "email", then: live.then, email: "", codeLength: null };
            signIn.current = again;
            setStep(again);
            say("What's your email address?");
            return true;
          }
          if (live.phase === "code" && /^(?:send (?:it|the code) again|resend(?: the code)?|new code)$/i.test(text.trim())) {
            void sendCode(live.email, live.then);
            return true;
          }
          if (live.phase === "email" || live.phase === "confirm") {
            const said = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
            if (live.phase === "confirm" && /^(?:yes|yeah|yep|yup|correct|right|that's right|that is right|ok|okay|send|send it|send the code)(?: please)?$/.test(said)) {
              void sendCode(live.email, live.then);
              return true;
            }
            if (live.phase === "confirm" && /^(?:no|nope|wrong|incorrect|try again)(?: please)?$/.test(said)) {
              const again: Extract<Step, { kind: "signin" }> = { kind: "signin", phase: "email", then: live.then, email: "", codeLength: null };
              signIn.current = again;
              setStep(again);
              say("What's your email address? Say each letter and number.");
              return true;
            }
            const email = parseSpokenEmail(text);
            if (!email) {
              say(
                live.phase === "confirm"
                  ? "Say yes if that's the right address, or say the email again, one letter and number at a time."
                  : "I didn't catch an email. Say it like a b c 8 1 1 at gmail dot com.",
              );
            } else offerEmail(email, live.then);
            return true;
          }
          const code = parseSpokenCode(text);
          if (!code) say("Say the digits from the email. Or say menu to stop.");
          else void checkCode(code);
          return true;
        }

        // While a story plays, everything else is for the story (answers, pause, next…).
        if (current.kind === "story") return false;

        if (command?.kind === "community") {
          void openCommunity();
          return true;
        }
        if (command?.kind === "mine") {
          void openMine();
          return true;
        }
        if (command?.kind === "continue-last") {
          void listMine().then((stories) => {
            const latest = stories[0];
            if (latest) resumeMine(latest);
            else goMenu("You don't have any stories yet. Say create a story to make your first one.");
          });
          return true;
        }

        if (current.kind === "community" || current.kind === "mine") {
          const titles = current.stories.map((s) => s.title);
          const picked = pickOption(text.replace(/^(?:play|continue|resume|listen to|open)\s+/i, ""), titles);
          if (picked !== null) {
            if (current.kind === "community") playCommunity(current.stories[picked]!);
            else resumeMine(current.stories[picked]!);
          } else {
            say(`I didn't catch which one. Say a number from one to ${Math.min(current.stories.length, 5)}, or a title. Or say menu.`);
          }
          return true;
        }

        if (current.kind === "create") {
          const changes = describeFields(create.fields);
          const form = { ...current.form, ...create.fields };
          if (create.action === "generate" || /^(?:generate|start|go|yes|start it|begin)$/i.test(text.trim())) {
            generate(form);
            return true;
          }
          if (changes.length) {
            setStep({ kind: "create", form });
            say(`Got it: ${changes.join(", ")}. Anything else? Or say generate.`);
          } else if (/^(?:what have i (?:chosen|picked)|read it back|summary|so far)/i.test(text.trim())) {
            say(`So far: ${describeFields(form).join(", ")}. Say generate when you're ready.`);
          } else {
            say("I didn't catch that. Say a kind of horror, your idea starting with about, a length, how scary, or a language. Say generate when you're ready.");
          }
          return true;
        }

        // The main menu: "create", or a whole creation sentence ("create a terrifying cosmic horror story about…").
        if (command?.kind === "create") {
          openCreate();
          return true;
        }
        const changes = describeFields(create.fields);
        if (create.action === "open" && changes.length) {
          const form = { ...DEFAULT_FORM, ...create.fields };
          openCreate(form, `Got it: ${changes.join(", ")}. Anything else? Or say generate.`);
          return true;
        }
        // Anything else ("tell me a scary story about a train") goes to the assistant, as before. For a guest that would
        // create a story, which needs an account, so they're asked to sign in (or told what they can say) instead.
        if (locked()) {
          if (/\b(?:story|stories|tale)\b/i.test(text)) startSignIn("create", "To create a story, sign in first.");
          else say(`I didn't catch that. ${MENU}`);
          return true;
        }
        setStep({ kind: "story" });
        return false;
      }),
    [],
  );

  // Back to the menu when a story ends, or when the listener leaves it ("go home", "cancel" at the play-mode question).
  const snapshot = useDevice();
  const active = Boolean(snapshot.view || snapshot.listen || snapshot.episode || snapshot.pick || snapshot.storyId);
  const sawStory = useRef(false);
  useEffect(() => {
    if (step.kind !== "story") {
      sawStory.current = false;
      return;
    }
    if (active) sawStory.current = true;
    const finished = snapshot.listen?.ended || snapshot.episode?.ended;
    if (finished) {
      const timer = setTimeout(() => goMenu(`That's the end. Want another? ${MENU}`), 2500);
      return () => clearTimeout(timer);
    }
    // Left the story: nothing playing or being written for a moment (a story starting has brief gaps between steps).
    const busy = snapshot.state === "thinking" || snapshot.state === "speaking" || snapshot.state === "listening" || snapshot.state === "connecting";
    if (sawStory.current && !active && !busy) {
      const timer = setTimeout(() => {
        sawStory.current = false;
        goMenu();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [step.kind, active, snapshot.state, snapshot.listen?.ended, snapshot.episode?.ended]);

  return (
    <div className="echo-menu" aria-live="polite">
      <span className="echo-menu-label">{step.kind === "story" ? "You can say" : step.kind === "menu" ? "Try saying" : "Say"}</span>
      <ul>
        {(step.kind === "community" || step.kind === "mine"
          ? step.stories.slice(0, 5).map((s, i) => `${i + 1}. ${s.title}`)
          : step.kind === "signin"
            ? step.phase === "code"
              ? ["The code from your email", "“Send it again”", "“Different email”", "“Menu” to stop"]
              : step.phase === "confirm"
                ? ["“Yes”", "Or say the email again", "“Menu” to stop"]
                : step.phase === "wait"
                  ? ["One moment"]
                  : ["a b c 8 1 1 at gmail dot com", "“Menu” to stop"]
            : HINTS[step.kind]
        )
          .filter(Boolean)
          .map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
      </ul>
    </div>
  );
}
