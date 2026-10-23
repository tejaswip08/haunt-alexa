import { Link } from "../router.tsx";

export function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <span className="eyebrow">An Alexa+ experience · built on MCP</span>
        <h1 className="hero-title">
          Stories that <em>listen</em> back.
        </h1>
        <p className="lede">
          Haunt is an interactive horror storyteller for Alexa+. Ask for a story out loud, and Haunt writes the opening
          scene, narrates it, and stops at the worst moment to ask what you do next. Answer in your own words, and the
          story bends around your choice.
        </p>
        <div className="hero-actions">
          <Link className="button primary" href="/alexa">
            Open the Alexa+ experience
          </Link>
          <Link className="button" href="/developers">
            Connect your AI
          </Link>
        </div>
        <p className="lede">
          No Echo needed: <Link href="/alexa">haunt-alexa.vercel.app/alexa</Link> runs an Echo Show and a voice-only
          Echo in your browser.
        </p>
      </section>

      <section className="pillars">
        <article className="card">
          <h2>Ask for a story</h2>
          <p>
            Say something like “Create a terrifying story about a lighthouse that lights itself.” Pick a sub-genre,
            length, fear level and language, or say it all in one sentence.
          </p>
        </article>
        <article className="card">
          <h2>Listen, then choose</h2>
          <p>
            Each scene is written by Claude on Amazon Bedrock and narrated by Amazon Polly. At every turn the narrator
            asks a real question, and whatever you answer becomes part of the story.
          </p>
        </article>
        <article className="card">
          <h2>A real MCP server</h2>
          <p>
            Alexa+ talks to Haunt’s self-hosted MCP server over Streamable HTTP, guided by an Agent Skill. On a screen,
            each scene arrives as an MCP Apps view, and you can watch every MCP message live as you play.
          </p>
        </article>
      </section>
    </div>
  );
}
