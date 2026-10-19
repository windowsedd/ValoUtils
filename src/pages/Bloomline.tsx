import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFlower2, LuRefreshCw, LuSearch } from "react-icons/lu";
import CustomButton from "@/components/button";
import { LoginRequiredPanel } from "@/components/login-required-panel";
import { PageHeader, SectionCard, SectionRow, pageBodyClass } from "@/components/section-card";
import { reportIpcError } from "@/util/ipc";
import { rateLimitedSeconds } from "@/util/rate-limit";
import { getAgents, localize, type AgentAsset } from "@/util/valorant-assets";
import {
  acceptedBloomlineDetail,
  bloomlineAgentRows,
  selectedBloomlineAgent,
  type BloomlineAgent,
  type BloomlineResponse,
} from "./bloomline/bloomline-state";

const track = (event: string) => invoke("analytics_track", { args: [event] }).catch(reportIpcError);
const amount = (value: number | null) => (value === null ? "—" : value.toLocaleString());

export const BloomlineContent = ({
  agents,
  assets,
  selectedId,
  onSelect,
  detail,
  detailLoading,
  detailError,
  onRetry,
}: {
  agents: BloomlineAgent[];
  assets: Map<string, AgentAsset>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail: BloomlineAgent | null;
  detailLoading: boolean;
  detailError: string | null;
  onRetry: () => void;
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const names = new Map([...assets].map(([id, asset]) => [id, localize(asset.name)]));
  const rows = bloomlineAgentRows(agents, names, query);
  const selected = agents.find((agent) => agent.agentId === selectedId);
  const name = (id: string) =>
    names.get(id) || `${t("bloomline.unknownAgent")} · ${id.slice(0, 8)}`;
  const shown = detail ?? selected;

  return (
    <div className="grid min-h-0 gap-4 @3xl:grid-cols-[minmax(18rem,1fr)_minmax(16rem,1fr)]">
      <SectionCard title={t("bloomline.agents")} count={agents.length}>
        <label className="mx-1 mb-3 flex items-center gap-2 rounded-[8px] border border-(--border) bg-(--control) px-3 py-2 focus-within:border-(--accent)">
          <LuSearch aria-hidden="true" className="shrink-0 text-(--text-secondary)" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("bloomline.search")}
            placeholder={t("bloomline.search")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-(--text-primary) outline-none placeholder:text-(--text-secondary)"
          />
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_4rem_5rem] gap-2 px-3 pb-2 text-[11px] text-(--text-secondary)">
          <span>{t("bloomline.agent")}</span>
          <span className="text-right">{t("bloomline.level")}</span>
          <span className="text-right">{t("bloomline.points")}</span>
        </div>
        <div className="max-h-[34rem] overflow-y-auto">
          {rows.map((agent) => (
            <button
              key={agent.agentId}
              type="button"
              onClick={() => onSelect(agent.agentId)}
              aria-pressed={selectedId === agent.agentId}
              className={`grid w-full grid-cols-[minmax(0,1fr)_4rem_5rem] items-center gap-2 rounded-[8px] px-3 py-2.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none ${selectedId === agent.agentId ? "bg-(--accent-soft) text-(--accent-selected)" : "text-(--text-primary) hover:bg-(--surface-hover)"}`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {assets.get(agent.agentId)?.icon ? (
                  <img
                    src={assets.get(agent.agentId)!.icon}
                    alt=""
                    className="size-9 shrink-0 object-contain"
                  />
                ) : (
                  <LuFlower2
                    aria-hidden="true"
                    className="size-9 shrink-0 p-1.5 text-(--text-secondary)"
                  />
                )}
                <span className="truncate" title={agent.agentId}>
                  {name(agent.agentId)}
                </span>
              </span>
              <span className="text-right tabular-nums">{amount(agent.level)}</span>
              <span className="text-right tabular-nums">{amount(agent.points)}</span>
            </button>
          ))}
          {rows.length === 0 && (
            <p className="px-3 py-6 text-[13px] text-(--text-secondary)">
              {t("bloomline.noResults")}
            </p>
          )}
        </div>
      </SectionCard>
      <div className="flex min-w-0 flex-col gap-4">
        <SectionCard title={selectedId ? name(selectedId) : t("bloomline.progression")}>
          <SectionRow>
            <span className="text-[13px] text-(--text-secondary)">{t("bloomline.level")}</span>
            <span className="text-[13px] tabular-nums">{amount(shown?.level ?? null)}</span>
          </SectionRow>
          <SectionRow>
            <span className="text-[13px] text-(--text-secondary)">{t("bloomline.longLevel")}</span>
            <span className="text-[13px] tabular-nums">{amount(shown?.longLevel ?? null)}</span>
          </SectionRow>
          <SectionRow>
            <span className="text-[13px] text-(--text-secondary)">{t("bloomline.points")}</span>
            <span className="text-[13px] tabular-nums">{amount(shown?.points ?? null)}</span>
          </SectionRow>
        </SectionCard>
        <SectionCard title={t("bloomline.stats")}>
          {detailLoading ? (
            <p role="status" className="px-3 py-5 text-[13px] text-(--text-secondary)">
              {t("bloomline.loadingStats")}
            </p>
          ) : detailError ? (
            <div role="alert" className="space-y-3 px-3 py-4">
              <p className="text-[13px] text-(--signal-neg)">{detailError}</p>
              <CustomButton color="secondary" onClick={onRetry}>
                {t("bloomline.retry")}
              </CustomButton>
            </div>
          ) : !detail?.stats?.length ? (
            <p className="px-3 py-5 text-[13px] text-(--text-secondary)">
              {t(detail?.stats === null ? "bloomline.statsUnavailable" : "bloomline.noStats")}
            </p>
          ) : (
            <>
              <p className="px-3 py-2 text-[12px] leading-5 text-(--text-secondary)">
                {t("bloomline.statsNote")}
              </p>
              <dl>
                {detail.stats.map((stat, index) => (
                  <div
                    key={`${stat.moduleId ?? stat.numberId}:${index}`}
                    className="flex items-center justify-between gap-3 border-t border-(--line) px-3 py-3"
                  >
                    <dt className="min-w-0">
                      <span className="text-[13px]">
                        {t("bloomline.statSlot", { number: index + 1 })}
                      </span>
                      <span
                        className="mt-1 block truncate font-mono text-[11px] text-(--text-secondary)"
                        title={stat.numberId}
                      >
                        {stat.numberId}
                      </span>
                    </dt>
                    <dd className="shrink-0 text-[14px] tabular-nums">{amount(stat.value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
};

const Bloomline = () => {
  const { t, i18n } = useTranslation();
  const [reply, setReply] = useState<BloomlineResponse | null>(null);
  const [assets, setAssets] = useState<Map<string, AgentAsset>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [detailState, setDetailState] = useState<{
    owner: string;
    agentId: string;
    reply: BloomlineResponse;
  } | null>(null);
  const agents = useMemo(() => (reply?.success ? (reply.agents ?? []) : []), [reply]);
  const owner = reply?.success ? (reply.puuid ?? null) : null;
  const selectedId = selectedBloomlineAgent(agents, selected);
  const loading = reply === null;
  const refresh = () => {
    setReload((value) => value + 1);
    void track("bloomline:refresh");
  };

  useEffect(() => {
    void track("bloomline:view");
    let active = true;
    getAgents().then((value) => {
      if (active) setAssets(value);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setReply(null);
    setDetailState(null);
    invoke<BloomlineResponse>("bloomline_get", { args: [] })
      .then((value) => {
        if (active) setReply(value);
      })
      .catch((error) => {
        if (active) setReply({ success: false, error: String(error) });
      });
    return () => {
      active = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!owner || !selectedId) return;
    let active = true;
    setDetailState(null);
    const apply = (value: BloomlineResponse) => {
      if (!active) return;
      if (value.code === "accountChanged" || value.code === "loginRequired") {
        setReply(value);
        setDetailState(null);
      } else {
        setDetailState({ owner, agentId: selectedId, reply: value });
      }
    };
    invoke<BloomlineResponse>("bloomline_get", { args: [selectedId, owner] })
      .then(apply)
      .catch((error) => apply({ success: false, error: String(error) }));
    return () => {
      active = false;
    };
  }, [owner, selectedId]);

  const errorText = (response: BloomlineResponse) => {
    const seconds = rateLimitedSeconds(response);
    if (seconds !== null) return t("common.rateLimited", { seconds });
    if (response.code === "accountChanged") return t("bloomline.accountChanged");
    return response.error || t("bloomline.failedToLoad");
  };
  const detailReply =
    detailState?.owner === owner && detailState.agentId === selectedId ? detailState.reply : null;
  const detail =
    owner && selectedId && detailReply
      ? acceptedBloomlineDetail(detailReply, owner, selectedId)
      : null;
  const detailError = detailReply && !detail ? errorText(detailReply) : null;

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <PageHeader
        icon={<LuFlower2 />}
        title={t("bloomline.title")}
        subtitle={t("bloomline.subtitle")}
      >
        <CustomButton color="secondary" isDisabled={loading} onClick={refresh}>
          <LuRefreshCw aria-hidden="true" />
          {t("bloomline.refresh")}
        </CustomButton>
      </PageHeader>
      <div className={pageBodyClass} lang={i18n.language}>
        {loading ? (
          <p role="status" className="py-8 text-[13px] text-(--text-secondary)">
            {t("bloomline.loading")}
          </p>
        ) : reply.code === "loginRequired" ? (
          <LoginRequiredPanel
            title={t("bloomline.loginRequired")}
            description={t("bloomline.loginDescription")}
            onRetry={refresh}
          />
        ) : !reply.success ? (
          <div role="alert" className="py-5">
            <p className="text-[13px] text-(--signal-neg)">{errorText(reply)}</p>
            <p className="mt-2 text-[12px] text-(--text-secondary)">{t("bloomline.retryHint")}</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="py-8">
            <p className="text-[14px] font-medium">{t("bloomline.empty")}</p>
            <p className="mt-2 text-[13px] text-(--text-secondary)">
              {t("bloomline.emptyDescription")}
            </p>
          </div>
        ) : (
          <BloomlineContent
            agents={agents}
            assets={assets}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelected(id);
              void track("bloomline:select");
            }}
            detail={detail}
            detailLoading={!detailReply}
            detailError={detailError}
            onRetry={refresh}
          />
        )}
      </div>
    </div>
  );
};

export default Bloomline;
