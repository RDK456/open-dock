import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { version } from "../package.json";

// Open Dock checks GitHub's latest release (tauri.conf.json → plugins.updater), downloads in the
// background, and waits for Restart because a restart drops connected phones for a few seconds.
// On Windows it first asks for a delta update (src-tauri/src/delta.rs): only a patch for the installed exe is
// downloaded. Without one (other platforms, an older install, a failed patch) the full installer is used.
export type UpdateState =
  | { kind: "idle" | "checking" }
  | { kind: "current"; checkedAt: number }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string; notes: string }
  | { kind: "error"; message: string };

const DAY = 24 * 60 * 60 * 1000;
const AUTO_KEY = "opendock.autoUpdate";

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [auto, setAutoState] = useState(() => { try { return localStorage.getItem(AUTO_KEY) !== "off"; } catch { return true; } });
  const busy = useRef(false);
  const ready = useRef<Update | "delta" | null>(null);

  const checkNow = useCallback(async () => {
    if (busy.current || ready.current) return;
    busy.current = true;
    setState({ kind: "checking" });
    try {
      const delta = await invoke<{ version: string; notes: string } | null>("download_delta_update").catch(() => null);
      if (delta) {
        ready.current = "delta";
        setState({ kind: "ready", version: delta.version, notes: delta.notes });
        return;
      }
      const update = await check();
      if (!update) { setState({ kind: "current", checkedAt: Date.now() }); return; }
      let total = 0, done = 0, shown = -1;
      setState({ kind: "downloading", version: update.version, percent: 0 });
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event !== "Progress" || !total) return;
        done += event.data.chunkLength;
        const percent = Math.floor((done / total) * 100);
        if (percent !== shown) { shown = percent; setState({ kind: "downloading", version: update.version, percent }); }
      });
      ready.current = update;
      setState({ kind: "ready", version: update.version, notes: update.body ?? "" });
    } catch (error) {
      // The updater reports ReleaseNotFound when GitHub answers without a release file (404: nothing
      // published yet, or the repo isn't public), so there's nothing newer. Network failures differ.
      if (String(error).includes("Could not fetch a valid release JSON")) setState({ kind: "current", checkedAt: Date.now() });
      else setState({ kind: "error", message: String(error) });
    } finally {
      busy.current = false;
    }
  }, []);

  // On Windows install() hands over to the installer, which closes and reopens Open Dock itself.
  const restart = useCallback(async () => {
    try {
      if (ready.current === "delta") { await invoke("install_delta_update"); return; }
      await ready.current?.install();
      await invoke("restart_app");
    }
    catch (error) { setState({ kind: "error", message: String(error) }); }
  }, []);

  const setAuto = (next: boolean) => {
    setAutoState(next);
    try { localStorage.setItem(AUTO_KEY, next ? "on" : "off"); } catch { /* the default stays on */ }
  };

  useEffect(() => {
    if (!auto) return;
    void checkNow();
    const timer = setInterval(() => void checkNow(), DAY);
    return () => clearInterval(timer);
  }, [auto, checkNow]);

  return { state, auto, setAuto, checkNow, restart };
}

function checkedAgo(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : `${Math.round(minutes / 60)} h ago`;
}

export function UpdatesSetting({ updater }: { updater: ReturnType<typeof useUpdater> }) {
  const { state, auto, setAuto, checkNow, restart } = updater;
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(timer); }, []);

  const title = state.kind === "ready" ? `Open Dock ${state.version} is ready` : "Updates";
  const detail = state.kind === "checking" ? "Checking for updates…"
    : state.kind === "current" ? `Open Dock ${version} is up to date. Checked ${checkedAgo(state.checkedAt)}.`
    : state.kind === "downloading" ? `Downloading Open Dock ${state.version}… ${state.percent}%`
    : state.kind === "ready" ? "Restart to finish. Connected phones reconnect on their own in a few seconds."
    : state.kind === "error" ? `Couldn't update Open Dock ${version}. Check your internet connection, then try again.`
    : `Open Dock ${version}`;
  const notes = state.kind === "ready" ? state.notes.split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean).slice(0, 6) : [];

  return <section className="device-navigation-setting updates-setting">
    <div className="device-navigation-copy"><h2>{title}</h2><p>{detail}</p></div>
    {state.kind === "ready"
      ? <button type="button" className="primary-button" onClick={() => void restart()}>Restart now</button>
      : <button type="button" className="secondary-button" disabled={state.kind === "checking" || state.kind === "downloading"} onClick={() => void checkNow()}>{state.kind === "error" ? "Try again" : "Check now"}</button>}
    {state.kind === "downloading" ? <div className="update-progress" role="progressbar" aria-valuenow={state.percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${state.percent}%` }} /></div> : null}
    {notes.length ? <ul className="update-notes">{notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {state.kind === "error" ? <p className="setting-error" title={state.message}>{state.message}</p> : null}
    <div className="update-auto">
      <span>Check for updates automatically</span>
      <button className={`setting-switch ${auto ? "enabled" : ""}`} type="button" role="switch" aria-checked={auto} aria-label="Check for updates automatically" onClick={() => setAuto(!auto)}><span /></button>
    </div>
  </section>;
}
