import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { reportIpcError } from "./ipc";

export type AiProvider = "none" | "anthropic" | "openai" | "gemini" | "compatible";
export type AiProviderSettings = { apiKey: string; model: string; baseUrl?: string };
export type AiSettings = {
  aiProvider: AiProvider;
  aiProviders: Partial<Record<Exclude<AiProvider, "none">, AiProviderSettings>>;
};
export const AI_DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
  compatible: "",
};
export function isAiConfigured(config: Partial<AiSettings>): boolean {
  const kind = config.aiProvider;
  if (!kind || kind === "none" || !(kind in AI_DEFAULT_MODELS)) return false;
  const settings = config.aiProviders?.[kind];
  if (!settings) return false;
  return kind === "compatible"
    ? !!settings.model?.trim() && !!settings.baseUrl?.trim()
    : !!settings.apiKey?.trim();
}
export function useAiConfigured(): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      invoke<AiSettings>("config_get_all")
        .then((config) => {
          if (active && current === generation) setConfigured(isAiConfigured(config));
        })
        .catch((error) => {
          if (active && current === generation) {
            setConfigured(false);
            reportIpcError(error);
          }
        });
    };
    refresh();
    window.addEventListener("valoutils:config-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("valoutils:config-changed", refresh);
    };
  }, []);
  return configured;
}
export type AiReply = {
  success: boolean;
  text?: string;
  provider?: string;
  model?: string;
  error?: string;
  code?: string;
};
