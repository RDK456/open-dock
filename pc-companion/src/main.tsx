import React from "react";
import ReactDOM from "react-dom/client";
import "./theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { Island } from "./island/Island";
import "./fonts/fonts.css";

// The same page also runs the voice island, a second window (see island.rs).
const isIsland = (() => { try { return getCurrentWindow().label === "island"; } catch { return false; } })();
if (isIsland) document.documentElement.classList.add("island-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isIsland ? <Island /> : <App />}
  </React.StrictMode>,
);
