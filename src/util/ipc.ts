import { listen, type UnlistenFn } from "@tauri-apps/api/event";


export const reportIpcError = (error: unknown) => {
  console.error("Tauri request failed:", error);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("valoutils:ipc-error", { detail: String(error) }));
};

/** React effects can unmount before Tauri finishes registering a listener. */
export function listenEvent<T>(
  event: string,
  callback: (payload: T) => void,
  register: (event: string, callback: (event: { payload: T }) => void) => Promise<UnlistenFn> = listen<T>,
): UnlistenFn {
  let active = true;
  let unlisten: UnlistenFn | undefined;
  register(event, message => { if (active) callback(message.payload); }).then(stop => {
    if (active) unlisten = stop;
    else stop();
  }).catch(reportIpcError);
  return () => { active = false; unlisten?.(); unlisten = undefined; };
}
