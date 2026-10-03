import { invoke } from "@tauri-apps/api/core";

const getClipboard = async () => (await invoke<{ text: string }>("clipboard_get")).text;
export default getClipboard;
