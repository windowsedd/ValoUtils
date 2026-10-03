import { reportIpcError } from "@/util/ipc";
import { invoke, isTauri } from "@tauri-apps/api/core";
export function openUrl(url: string) {
  if (isTauri()) invoke("open_url", { args: [url] }).catch(reportIpcError);
  else window.open(url);
}
