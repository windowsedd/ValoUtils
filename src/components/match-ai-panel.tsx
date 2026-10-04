import CustomButton from "./button";
import { buildMatchAnalysisContext } from "./match-ai-analysis";
import type { MatchAssets } from "./match-scoreboard";
import type { MatchDetails } from "@/types/matches";
import { useAiConfigured, type AiReply } from "@/util/ai";
import { invoke } from "@tauri-apps/api/core";
import { reportIpcError } from "@/util/ipc";
import { useTranslation } from "react-i18next";
import { LuSparkles } from "react-icons/lu";

export function MatchAiPanel({
  details,
  assets,
  text,
  onResult,
  pending,
  onStart,
  onFinish,
}: {
  details: MatchDetails;
  assets: MatchAssets;
  text?: string;
  onResult: (text: string) => void;
  pending: boolean;
  onStart: () => boolean;
  onFinish: () => void;
}) {
  const { t, i18n } = useTranslation();
  const configured = useAiConfigured();
  const analyze = async () => {
    if (!onStart()) return;
    try {
      invoke("analytics_track", { args: ["ai:match_analyze"] }).catch(reportIpcError);
      const language = i18n.language.startsWith("ko")
        ? "Korean"
        : i18n.language.startsWith("zh")
          ? "Traditional Chinese"
          : "English";
      let reply: AiReply;
      try {
        reply = await invoke<AiReply>("ai_match_analyze", {
          args: [buildMatchAnalysisContext(details, assets), language],
        });
      } catch {
        throw t("ai.errors.unavailable");
      }
      if (!reply.success || !reply.text)
        throw t(`ai.errors.${reply.code}`, { defaultValue: t("ai.errors.unavailable") });
      onResult(reply.text);
    } finally {
      onFinish();
    }
  };
  return (
    <div className="mb-3 rounded-md border border-(--line) p-3">
      <span title={configured ? undefined : t("ai.configureHint")}>
        <CustomButton
          isDisabled={!configured || pending}
          isLoading={pending}
          onClickLoading={analyze}
        >
          <LuSparkles />
          {t(text ? "ai.regenerate" : "ai.analyze")}
        </CustomButton>
      </span>
      {!configured && <p className="mt-2 text-xs text-(--text-muted)">{t("ai.configureHint")}</p>}
      {text && <p className="mt-3 whitespace-pre-wrap text-sm text-(--text-primary)">{text}</p>}
    </div>
  );
}
