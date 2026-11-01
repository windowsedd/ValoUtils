import { useEffect, useMemo, useState } from "react";
import { LuHistory, LuMessageSquare, LuSearch } from "react-icons/lu";
import type { SavedChatMatch } from "@/types/chat";
import { useAgentAssets } from "@/util/use-agent-assets";
import { getMaps, localize, type MapAsset } from "@/util/valorant-assets";
import { queueLabel } from "@/util/valorant-queues";
import { matchOutcome, relativeDay, savedMatchList, type MatchOutcome, type SavedMatchSummary } from "./saved-match-history";

export type SavedMatchPickerLabels = {
	title: string;
	current: string;
	currentHint: string;
	empty: string;
	search: string;
	noResults: string;
	today: string;
	yesterday: string;
	counts: (team: number, all: number) => string;
	speakers: (count: number) => string;
	noMessages: string;
	outcome: Record<MatchOutcome, string>;
};

const OUTCOME_CLASS: Record<MatchOutcome, string> = {
	win: "border-(--signal-pos)/40 text-(--signal-pos)",
	loss: "border-(--signal-neg)/40 text-(--signal-neg)",
	draw: "border-(--border) text-(--text-secondary)",
};

/** Riot's mapId is the asset path; getMaps keys both it and its last segment. */
const mapFor = (maps: Map<string, MapAsset>, mapId: string) => {
	const key = mapId.toLowerCase();
	return maps.get(key) ?? maps.get(key.split("/").filter(Boolean).pop() ?? "") ?? null;
};

const rowClass = (selected: boolean) =>
	`flex w-full flex-col gap-0.5 rounded-[8px] border px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
		selected
			? "border-(--accent-border) bg-[rgba(128,100,233,0.15)]"
			: "border-transparent hover:bg-(--surface-hover)"
	}`;

const whenLabel = (summary: SavedMatchSummary, now: number, labels: SavedMatchPickerLabels) => {
	const time = new Date(summary.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const day = relativeDay(summary.at, now);
	const date =
		day === "today"
			? labels.today
			: day === "yesterday"
				? labels.yesterday
				: new Date(summary.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${date} · ${time}`;
};

export const SavedMatchPicker = ({
	matches,
	channel,
	selected,
	onSelect,
	labels,
}: {
	matches: readonly SavedChatMatch[];
	channel: "team" | "all";
	selected: string | null;
	onSelect: (matchUuid: string | null) => void;
	labels: SavedMatchPickerLabels;
}) => {
	const [query, setQuery] = useState("");
	const list = useMemo(() => savedMatchList(matches, channel, query), [matches, channel, query]);
	const now = Date.now();
	const [maps, setMaps] = useState<Map<string, MapAsset>>(new Map());
	const hasDetails = matches.some((match) => match.details);
	useEffect(() => {
		if (!hasDetails) return;
		let cancelled = false;
		getMaps()
			.then((loaded) => {
				if (!cancelled) setMaps(loaded);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [hasDetails]);
	const agents = useAgentAssets(matches.map((match) => match.details?.agentId));

	return (
		<section data-saved-match-picker="" aria-label={labels.title} className="flex flex-col px-2 pb-1 pt-2">
			<h3 className="flex items-center justify-between px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
				<span>{labels.title}</span>
				<span className="tabular-nums">{matches.length || ""}</span>
			</h3>

			<button type="button" aria-current={selected === null || undefined} onClick={() => onSelect(null)} className={rowClass(selected === null)}>
				<span className="flex items-center gap-1.5 text-[12px] font-medium text-(--text-primary)">
					<LuMessageSquare className="size-3.5 shrink-0 text-(--signal-pos)" />
					{labels.current}
				</span>
				<span className="truncate text-[11px] text-(--text-muted)">{labels.currentHint}</span>
			</button>

			{matches.length === 0 ? (
				<p className="px-2 pt-2 text-[11px] leading-5 text-(--text-muted)">{labels.empty}</p>
			) : (
				<>
					{matches.length > 3 && (
						<label className="mx-0.5 mt-2 flex h-7 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-2 focus-within:border-(--accent)">
							<LuSearch className="size-3 shrink-0 text-(--text-muted)" />
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={labels.search}
								aria-label={labels.search}
								className="min-w-0 flex-1 bg-transparent text-[11px] text-(--text-primary) outline-none placeholder:text-(--text-muted)"
							/>
						</label>
					)}
					<div className="mt-1.5 flex max-h-60 flex-col gap-0.5 overflow-y-auto">
						{list.length === 0 && <p className="px-2 py-2 text-[11px] text-(--text-muted)">{labels.noResults}</p>}
						{list.map((summary) => {
							const isSelected = selected === summary.matchUuid;
							const details = summary.details;
							const map = details ? mapFor(maps, details.mapId) : null;
							const agent = details?.agentId ? agents.get(details.agentId) : undefined;
							const outcome = matchOutcome(details);
							const mapName = map ? localize(map.name) : "";
							const mode = details ? queueLabel(details.queueId) : "";
							const heading = [mapName, mode].filter(Boolean).join(" · ");
							const art = map?.listViewIcon;
							return (
								<button
									key={summary.matchUuid}
									type="button"
									data-saved-match={summary.matchUuid}
									aria-current={isSelected || undefined}
									onClick={() => onSelect(summary.matchUuid)}
									title={summary.matchUuid}
									className={`relative overflow-hidden ${rowClass(isSelected)}`}
								>
									{art && (
										<img
											src={art}
											alt=""
											aria-hidden="true"
											className="pointer-events-none absolute inset-y-0 right-0 h-full w-2/3 object-cover opacity-25 [mask-image:linear-gradient(to_right,transparent,black)]"
										/>
									)}
									<span className="relative flex items-center gap-2">
										{agent?.icon ? (
											<img
												src={agent.icon}
												alt={localize(agent.name)}
												title={localize(agent.name)}
												className="size-8 shrink-0 rounded-[6px] bg-(--control) object-cover"
											/>
										) : (
											<span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-(--control)">
												<LuHistory className="size-3.5 text-(--text-muted)" />
											</span>
										)}
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="flex items-center justify-between gap-2">
												<span className="truncate text-[12px] font-medium text-(--text-primary)">
													{heading || whenLabel(summary, now, labels)}
												</span>
												{outcome && details && (
													<span
														data-outcome={outcome}
														className={`shrink-0 rounded-[4px] border px-1 text-[10px] font-semibold tabular-nums ${OUTCOME_CLASS[outcome]}`}
													>
														{labels.outcome[outcome]} {details.roundsWon}–{details.roundsLost}
													</span>
												)}
											</span>
											<span className="truncate text-[10px] tabular-nums text-(--text-muted)">
												{heading ? `${whenLabel(summary, now, labels)} · ` : ""}
												{labels.speakers(summary.speakers)}
											</span>
										</span>
									</span>
									<span className="relative truncate text-[11px] text-(--text-secondary)">
										{summary.last ? (
											<>
												<span className="text-(--text-muted)">{summary.last.senderName || "?"}: </span>
												{summary.last.body}
											</>
										) : (
											labels.noMessages
										)}
									</span>
									<span className="relative text-[10px] tabular-nums text-(--text-muted)">{labels.counts(summary.team, summary.all)}</span>
								</button>
							);
						})}
					</div>
				</>
			)}
		</section>
	);
};
