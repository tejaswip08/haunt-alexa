import { Admin } from "./pages/Admin.tsx";
import { Developers } from "./pages/Developers.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Privacy, Terms } from "./pages/Legal.tsx";
import { Library } from "./pages/Library.tsx";
import { MyStories } from "./pages/MyStories.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { Play } from "./pages/Play.tsx";
import { Tv } from "./pages/Tv.tsx";
import { ViewGallery } from "./pages/ViewGallery.tsx";
import { Link, usePath } from "./router.tsx";

const PAGES: Record<string, () => React.JSX.Element> = {
  "/": Landing,
  "/alexa": Play,
  "/library": Library,
  "/my-stories": MyStories,
  "/developers": Developers,
  "/admin": Admin,
  "/privacy": Privacy,
  "/terms": Terms,
  ...(import.meta.env.DEV ? { "/dev/views": ViewGallery } : {}),
};

// The site's menu: the Alexa+ device and the developer page. Library and My stories live inside the Alexa+ device now
// (its Community and My Stories tabs); their pages still open from a direct link.
const NAV = [
  { href: "/alexa", label: "Alexa+" },
  { href: "/developers", label: "Developers" },
];

export function App() {
  let path = usePath();
  // The Alexa+ simulator moved from /play to /alexa. Old links (with ?episode=, ?resume= or ?say=) still land there.
  if (path === "/play") {
    window.history.replaceState(null, "", `/alexa${window.location.search}`);
    path = "/alexa";
  }
  // The Fire TV app is full screen, without the website's header and footer.
  if (path === "/tv") return <Tv />;
  if (path === "/sign-in") return <SignIn />;
  const Page = PAGES[path] ?? NotFound;
  // Every page wears the Fire TV app's look (apps/tv/src/theme.ts; data-skin is set on <html> in index.html).
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand-link" aria-label="Haunt home">
          <span className="tv-wordmark">
            HAUNT
            <span className="tv-wordmark-bar" aria-hidden />
          </span>
        </Link>
        {/* No account button here: signing in happens inside the Alexa+ device (its Profile). */}
        <div className="topbar-right">
          <nav>
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className={path === item.href ? "is-active" : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      {/* Keyed by page so each page fades in when you arrive. */}
      <main key={path} className="page-enter">
        <Page />
      </main>
      <footer className="footer muted">
        Haunt is an independent project built for the Amazon Developer Hackathon. It is not affiliated with or endorsed
        by Amazon. Stories are AI-generated fiction.{" "}
        <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
      </footer>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1>Nothing here</h1>
      <p className="lede">This page has vanished.</p>
      <Link className="button" href="/">
        Go home
      </Link>
    </div>
  );
}
