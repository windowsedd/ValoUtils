import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Compatibility shim: the whole renderer was written against Electron's
// `window.Main.send/on/removeAllListeners` (defined previously in
// electron/preload.ts), request/response over a shared channel name, with
// JSON strings as payloads. Rather than rewrite every call site as each
// backend module gets ported to Rust, this shim preserves that exact
// contract on top of Tauri's invoke()/event system:
//   - send(channel, ...args) -> invoke(<rustCommandName>, { args })
//     the resolved value (a JSON string, matching the old `event.sender.send`
//     convention) is delivered to any callback registered via on(channel, cb).
//   - on(channel, cb) also subscribes to a same-named Tauri event, so
//     Rust-side `app.emit(channel, json)` pushes (e.g. progress, alerts)
//     reach the same callback without the renderer needing to call send().
// Tauri command names must be valid Rust identifiers, so ":"/"-" in channel
// names are mapped to "_" only for the invoke() call; emitted events keep
// the original channel string.
type Callback = (data: any) => void;

const listeners = new Map<string, Set<Callback>>();
const unlistenFns = new Map<string, UnlistenFn>();

function toCommandName(channel: string): string {
  return channel.replace(/[:-]/g, "_");
}

function ensureEventBridge(channel: string) {
  if (unlistenFns.has(channel)) return;
  unlistenFns.set(channel, () => {}); // placeholder to avoid double-subscribe races
  listen<string>(channel, (event) => {
    const cbs = listeners.get(channel);
    if (cbs) cbs.forEach((cb) => cb(event.payload));
  }).then((unlisten) => {
    unlistenFns.set(channel, unlisten);
  });
}

const api = {
  send: (channel: string, ...message: any[]) => {
    invoke<string>(toCommandName(channel), { args: message })
      .then((result) => {
        const cbs = listeners.get(channel);
        if (cbs) cbs.forEach((cb) => cb(result));
      })
      .catch((err) => {
        console.error(`[tauri-bridge] invoke "${channel}" failed:`, err);
      });
  },
  on: (channel: string, callback: Callback) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(callback);
    ensureEventBridge(channel);
  },
  removeAllListeners: (channel: string) => {
    listeners.delete(channel);
  },
  removeListener: (channel: string, callback: Callback) => {
    listeners.get(channel)?.delete(callback);
  },
};

declare global {
  interface Window {
    Main: typeof api;
  }
}

window.Main = api;

export {};
