import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readInterventions, readPenalties } from "@/pages/player-career-status";
import { SectionCard } from "./section-card";
import { reportIpcError } from "@/util/ipc";

type Check = { success: true; data: unknown } | { success: false; code?: string };
type Response = { success: true; penalties: Check; interventions: Check } | { success: false; code?: string };

export const CareerAccountStatus = ({ puuid }: { puuid: string }) => {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ owner: string; response: Response } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const response = result?.owner === puuid ? result.response : null;
  useEffect(() => {
    let active = true;
    setResult(null);
    invoke<Response>("career_account_status", { args: [puuid] })
      .then(response => { if (active) setResult({owner: puuid, response}); })
      .catch(() => { if (active) setResult({owner: puuid, response: {success: false}}); });
    return () => { active = false; };
  }, [puuid, refresh]);
  const penalties = response?.success && response.penalties.success ? readPenalties(response.penalties.data) : null;
  const interventions = response?.success && response.interventions.success ? readInterventions(response.interventions.data) : null;
  const expiry = (value: string) => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? t(time <= Date.now() ? "career.statusExpired" : "career.statusExpires", {date: new Date(time).toLocaleString()}) : "";
  };
  const label = (value: string) => value.replace(/Effect$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  const failure = (check: Check | undefined) => t(check && !check.success && check.code === "accountChanged" ? "career.statusAccountChanged" : "career.statusUnavailable");
  return <SectionCard title={t("career.accountStatus")} className="min-w-0" right={
    <button type="button" disabled={!response} className="text-[10px] text-(--text-muted) hover:text-(--text-primary) disabled:opacity-40"
      onClick={() => { setResult(null); setRefresh(n => n + 1); invoke("analytics_track", {args: ["career:status-refresh"]}).catch(reportIpcError); }}>
      {t("chat.refresh")}
    </button>
  }>
    {!response ? <p role="status" className="p-2 text-[11px] text-(--text-muted)">{t("career.statusLoading")}</p> : <div className="space-y-4 break-words p-2 text-[11px]">
      <section aria-label={t("career.penalties")}>
        <h3 className="mb-2 font-semibold text-(--text-primary)">{t("career.penalties")}</h3>
        {penalties === null ? <p role="status" className="text-(--text-muted)">{failure(response.success ? response.penalties : undefined)}</p> : penalties.length === 0 ?
          <p className="text-(--signal-pos)">{t("career.noPenalties")}</p> : <ul className="space-y-3">
            {penalties.map(penalty => <li key={penalty.id} className="border-l-2 border-(--signal-neg) pl-2">
              <p className="font-medium text-(--text-primary)">{penalty.reason || t("career.penalty")}</p>
              {penalty.effects.map(effect => <p key={effect} className="text-(--text-secondary)">{t(`career.penaltyEffects.${effect}`, {defaultValue: label(effect)})}</p>)}
              {expiry(penalty.expiry) && <p className="mt-1 text-(--text-muted)">{expiry(penalty.expiry)}</p>}
              {penalty.gamesRemaining > 0 && <p className="text-(--text-muted)">{t("career.statusGamesRemaining", {count: penalty.gamesRemaining})}</p>}
            </li>)}
          </ul>}
      </section>
      <section aria-label={t("career.interventions")}>
        <h3 className="mb-2 font-semibold text-(--text-primary)">{t("career.interventions")}</h3>
        {interventions === null ? <p role="status" className="text-(--text-muted)">{failure(response.success ? response.interventions : undefined)}</p> : interventions.length === 0 ?
          <p className="text-(--signal-pos)">{t("career.noInterventions")}</p> : <ul className="space-y-3">
            {interventions.map((category, index) => <li key={`${category.category}:${category.rating}:${index}`}>
              <p className="font-medium text-(--text-primary)">{label(category.rating || category.category)}</p>
              {category.active.length === 0 ? <p className="mt-1 text-(--text-muted)">{t("career.noActiveInterventions")}</p> : <ul className="mt-1 space-y-2">
                {category.active.map((item, index) => <li key={`${item.name}:${item.issuedAt}:${index}`} className="border-l-2 border-(--signal-neg) pl-2">
                  <p className="text-(--text-secondary)">{label(item.name)}</p>
                  {item.reason && <p className="text-(--text-muted)">{label(item.reason)}</p>}
                  {expiry(item.expiry) && <p className="text-(--text-muted)">{expiry(item.expiry)}</p>}
                </li>)}
              </ul>}
              {category.next.length > 0 && <p className="mt-2 text-(--text-muted)">{t("career.nextInterventions", {names: category.next.map(label).join(", ")})}</p>}
            </li>)}
          </ul>}
      </section>
    </div>}
  </SectionCard>;
};
