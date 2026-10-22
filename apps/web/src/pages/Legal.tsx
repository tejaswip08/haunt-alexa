import { useEffect } from "react";
import { installDpad, focusFirst } from "../lib/dpad.ts";
import { Link } from "../router.tsx";

/**
 * Privacy policy and terms. They describe what this code actually does; update them
 * whenever data handling changes (new storage, analytics, accounts or services).
 */

const UPDATED = "October 17, 2026";
/** Shown on both pages. Replace with the project's real contact address before publishing. */
export const CONTACT = "the contact address listed on the Haunt Devpost page";

/** On the TV, Back returns to the app instead of closing it. */
function useTvBack() {
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("tv")) return;
    const timer = setTimeout(focusFirst, 50);
    const uninstall = installDpad({
      onBack: () => {
        window.history.back();
        return true;
      },
    });
    return () => {
      clearTimeout(timer);
      uninstall();
    };
  }, []);
}

function LegalNav({ current }: { current: "privacy" | "terms" }) {
  const tv = new URLSearchParams(window.location.search).has("tv");
  const suffix = tv ? "?tv" : "";
  return (
    <nav className="legal-nav" aria-label="Legal">
      {current === "privacy" ? (
        <Link href={`/terms${suffix}`} data-focusable="" data-autofocus="">
          Terms of use →
        </Link>
      ) : (
        <Link href={`/privacy${suffix}`} data-focusable="" data-autofocus="">
          Privacy policy →
        </Link>
      )}
      {tv && (
        <button type="button" className="button" data-focusable onClick={() => window.history.back()}>
          Back to Haunt
        </button>
      )}
    </nav>
  );
}

export function Privacy() {
  useTvBack();
  return (
    <article className="page legal">
      <h1>Privacy policy</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p className="lede">
        Haunt is an independent hackathon project. This page explains, plainly, what happens to what you type, say and
        choose while you use it.
      </p>

      <h2>What Haunt receives</h2>
      <ul>
        <li>
          <strong>Your story input.</strong> The story idea you pick or say, and every answer you give the narrator, as
          text.
        </li>
        <li>
          <strong>Your voice, only when you press “Speak an answer”.</strong> Where your browser or device can
          recognise speech itself, it does so and Haunt's server only receives the resulting text. Your browser or
          device maker may process the audio to do this (for example, Chrome uses Google's speech service, and Android
          uses the device's speech recognition service), under their own privacy terms.
        </li>
        <li>
          <strong>Recordings, in browsers that can't recognise speech.</strong> If Haunt's own speech recognition is
          switched on and your browser can't recognise speech (for example Brave), your answer is recorded (up to 12
          seconds, after you press the button) and sent to Haunt's server, which passes it to Amazon Transcribe and
          returns the text to you to confirm. Haunt keeps the recording only in memory for that request and never saves
          it. Amazon states that Amazon Transcribe may temporarily store content to improve its service; see the AWS
          documentation and AI services opt-out policies.
        </li>
        <li>
          <strong>Normal web request data.</strong> Like any website, the server sees your IP address and browser
          details when you connect. Haunt does not use them to identify you and has no analytics or advertising
          trackers.
        </li>
      </ul>

      <h2>How it is used</h2>
      <ul>
        <li>
          <strong>Writing the story.</strong> Your idea, your answers and the story so far are sent to Anthropic's
          Claude model on Amazon Bedrock (Amazon Web Services) to write the next turn, and to decide whether your
          answer matches a turn written in advance.
        </li>
        <li>
          <strong>Narration.</strong> Story text is sent to Amazon Polly to produce the narrator's voice. When server
          narration is off, your browser or device reads the text aloud instead.
        </li>
        <li>
          <strong>The simulated assistant.</strong> On the Alexa+ simulator page, what you say is also sent to Claude on
          Amazon Bedrock so the assistant can decide what to do next.
        </li>
      </ul>
      <p>
        Haunt does not sell your data or use it for advertising. Amazon's and Anthropic's handling of data sent to
        Bedrock is governed by AWS's terms and privacy notice.
      </p>

      <h2>What is stored, and for how long</h2>
      <ul>
        <li>
          <strong>Stories.</strong> Each story is saved on the Haunt server (as a file, or in Amazon DynamoDB) under a
          random story id, so it can continue across turns and devices. A saved story contains the turns, your
          answers word for word, and what each choice meant. On the hosted service, stories are deleted automatically
          about 45 days after their last turn. On a local copy of Haunt they stay until removed.
        </li>
        <li>
          <strong>Published episodes.</strong> The Haunt team can publish a finished story to the public library. An
          episode contains only the narrator's text and a pen name chosen at publishing time, never your answers or
          your voice.
        </li>
        <li>
          <strong>Server logs.</strong> The server logs errors and model usage counts. These logs can include parts of
          a request when something fails.
        </li>
        <li>
          <strong>Your browser.</strong> Haunt sets no cookies. The admin page keeps its access token in session
          storage until the tab is closed.
        </li>
      </ul>

      <h2>Accounts and children</h2>
      <p>
        Haunt has no user accounts. Stories are AI-generated horror fiction intended for adults. Please don't enter
        personal information, such as your name, address or phone number, into a story.
      </p>

      <h2>Third parties</h2>
      <ul>
        <li>Amazon Web Services: Amazon Bedrock (story writing), Amazon Polly (narration), and hosting and storage.</li>
        <li>Anthropic: the Claude model, provided through Amazon Bedrock.</li>
        <li>Google Fonts: the website loads its fonts from Google, which receives your IP address.</li>
        <li>Amazon Transcribe, for recorded answers when Haunt's own speech recognition is used.</li>
        <li>Your browser or device's speech recognition and text-to-speech services, when you use voice.</li>
      </ul>

      <h2>Your choices</h2>
      <p>
        You can use Haunt entirely with the remote or by tapping, without a microphone. To ask for a story to be
        deleted, contact {CONTACT} with the story's title and the date you played it.
      </p>

      <h2>Changes</h2>
      <p>If Haunt starts handling data differently, this page will be updated first and the date above will change.</p>
      <p className="muted">Haunt is not affiliated with or endorsed by Amazon or Anthropic.</p>
      <LegalNav current="privacy" />
    </article>
  );
}

export function Terms() {
  useTvBack();
  return (
    <article className="page legal">
      <h1>Terms of use</h1>
      <p className="muted">Last updated {UPDATED}</p>
      <p className="lede">Short version: Haunt is a free experiment. Play kindly, and expect the occasional glitch.</p>

      <h2>What Haunt is</h2>
      <p>
        Haunt is an independent project built for the Amazon Developer Hackathon. It tells interactive horror stories
        written by an AI model. It is provided free of charge, as is, without any warranty, and it may change or go
        offline at any time.
      </p>

      <h2>AI-generated fiction</h2>
      <p>
        Every story is fiction written by AI as you play. It can be frightening, strange, repetitive or occasionally
        wrong. It is not advice of any kind. Haunt is meant for adults; the stories avoid graphic content, but they are
        horror.
      </p>

      <h2>Your part</h2>
      <ul>
        <li>Don't use Haunt to create content that is illegal, hateful, sexual, or that targets real people.</li>
        <li>Don't try to break, overload or misuse the service or the AI models behind it.</li>
        <li>Don't enter personal or sensitive information into a story.</li>
      </ul>

      <h2>Stories and the library</h2>
      <p>
        The story ideas and answers you contribute are yours. By playing, you let Haunt store your story and process it
        as described in the privacy policy. The Haunt team may publish a finished story's narration to the public
        library under a pen name; your answers are never published.
      </p>

      <h2>Open source</h2>
      <p>
        The FireTales story engine is open source under the Apache License 2.0. Its license, not these terms, governs
        your use of that code.
      </p>

      <h2>Liability</h2>
      <p>To the extent the law allows, the Haunt team is not liable for any loss arising from using Haunt.</p>

      <h2>Contact</h2>
      <p>Questions about these terms: {CONTACT}.</p>
      <p className="muted">Haunt is not affiliated with or endorsed by Amazon or Anthropic.</p>
      <LegalNav current="terms" />
    </article>
  );
}
