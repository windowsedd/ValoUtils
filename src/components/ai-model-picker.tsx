import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import CustomButton from "./button";
import { AI_DEFAULT_MODELS, type AiProvider, type AiProviderSettings } from "@/util/ai";
import { reportIpcError } from "@/util/ipc";

type Model = { id: string; name: string };
type ModelReply = { success: boolean; models?: Model[]; code?: string };
const controlClass =
  "h-7 w-56 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[12px] text-(--text-primary)";

export function AiModelPicker({
  provider,
  settings,
  onChange,
}: {
  provider: Exclude<AiProvider, "none">;
  settings: AiProviderSettings;
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  // Lists belong to the provider, credentials and endpoint, not the selected model.
  const scope = JSON.stringify([provider, settings.apiKey, settings.baseUrl]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [result, setResult] = useState<{ scope: string; models: Model[] } | null>(null);
  const models = result?.scope === scope ? result.models : [];
  const canFetch =
    provider === "compatible" ? !!settings.baseUrl?.trim() : !!settings.apiKey?.trim();
  const fetchModels = async () => {
    const requestedScope = scope;
    invoke("analytics_track", { args: ["ai:models_fetch", JSON.stringify({ provider })] }).catch(
      reportIpcError,
    );
    let reply: ModelReply;
    try {
      reply = await invoke<ModelReply>("ai_models", { provider, settings });
    } catch {
      if (active.current && currentScope.current === requestedScope)
        throw t("ai.errors.unavailable");
      return;
    }
    if (!active.current || currentScope.current !== requestedScope) return;
    if (!reply.success)
      throw t(`ai.errors.${reply.code}`, { defaultValue: t("ai.errors.unavailable") });
    setResult({ scope: requestedScope, models: reply.models ?? [] });
  };
  return (
    <div className="flex max-w-[32rem] flex-wrap items-center justify-end gap-2">
      <input
        aria-label={t("ai.model")}
        value={settings.model}
        placeholder={AI_DEFAULT_MODELS[provider]}
        className={controlClass}
        onChange={(event) => onChange(event.target.value)}
      />
      <span title={canFetch ? undefined : t("ai.modelsCredentials")}>
        <CustomButton isDisabled={!canFetch} onClickLoading={fetchModels}>
          {t("ai.fetchModels")}
        </CustomButton>
      </span>
      {models.length > 0 && (
        <select
          aria-label={t("ai.availableModels")}
          className={controlClass}
          value={models.some((model) => model.id === settings.model) ? settings.model : ""}
          onChange={(event) => {
            if (!event.target.value) return;
            onChange(event.target.value);
            invoke("analytics_track", {
              args: ["ai:model_select", JSON.stringify({ provider })],
            }).catch(reportIpcError);
          }}
        >
          <option value="" disabled>
            {t("ai.chooseModel")}
          </option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name === model.id ? model.id : `${model.name} (${model.id})`}
            </option>
          ))}
        </select>
      )}
      <p className="basis-full text-right text-[11px] text-(--text-muted)">
        {result?.scope === scope && models.length === 0 ? t("ai.noModels") : t("ai.modelsHint")}
      </p>
    </div>
  );
}
