import { invoke } from "@tauri-apps/api/core";

/** Fetch a shared profile blob by its pastes.dev code (via the Rust backend). */
export const getData = async (id: string): Promise<string> => {
    return invoke<string>("share_get_data", { args: [id] });
};
