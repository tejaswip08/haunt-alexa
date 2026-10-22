import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { session } from "./lib/session.ts";
import "@haunt/scene-fx/fx.css";
import "./styles.css";

void session.init();
createRoot(document.getElementById("root")!).render(<App />);
