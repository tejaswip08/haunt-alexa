import { CinematicHome } from "../components/CinematicHome.tsx";
import { Link } from "../router.tsx";

export function Landing() {
  return (
    <div className="landing">
      <CinematicHome />
      <section className="hero">
        <span className="eyebrow">An Alexa+ experience · built on MCP</span>
        <h1 className="hero-title">
          Stories that <em>listen</em> back.
        </h1>
        <p className="lede">
          Haunt tells original horror stories out loud and stops to ask what you do next. Answer in your own words, and
          the story bends around your choice, all the way to an ending no one else will hear quite the same way.
        </p>
        <div className="hero-actions">
          <Link className="button primary" href="/alexa">
            Try it now
          </Link>
          <Link className="button" href="/developers">
            Connect your AI
          </Link>
        </div>
      </section>

      <section className="pillars">
        <article className="card">
          <h2>Speak, don’t tap</h2>
          <p>
            The narrator asks a real question at every turn. There is no menu: whatever you say becomes part of the
            story, and the facts you create never disappear.
          </p>
        </article>
        <article className="card">
          <h2>A real MCP server</h2>
          <p>
            Every turn comes from a self-hosted MCP server over Streamable HTTP, with an MCP App view for screens. Watch
            the live traffic as you play, or connect it to your own assistant.
          </p>
        </article>
        <article className="card">
          <h2>Powered by FireTales</h2>
          <p>
            The storytelling engine is open source. Use it to build bedtime adventures, mysteries or interactive
            podcasts that remember every choice.
          </p>
        </article>
      </section>
    </div>
  );
}
