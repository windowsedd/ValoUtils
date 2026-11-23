import { useTranslation } from "react-i18next";
import type { MatchDetails, MatchPlayer } from "@/types/matches";
import { localize } from "@/util/valorant-assets";
import type { MatchAssets } from "./match-scoreboard";

type DuelLine = {
	player: MatchPlayer;
	kills: number;
	deaths: number;
	dealt: number;
	taken: number;
	openingsWon: number;
	openingsLost: number;
};

/**
 * One player's head-to-head against every opponent in a match: kills and deaths
 * between the two, damage dealt and taken, and opening kills (the first kill of
 * a round) won and lost. Built from the scoreboard's `duels`.
 */
export const matchDuels = (details: MatchDetails, player: MatchPlayer): DuelLine[] | null => {
	if (!details.duels) return null;
	const me = player.subject.toLowerCase();
	const pairs = new Map(details.duels.pairs.map((pair) => [`${pair.from}>${pair.to}`, pair]));
	// Deathmatch gives every player a team of their own: everyone is an opponent.
	const teams = new Set(details.players.map((other) => other.teamId));
	const freeForAll = teams.size === details.players.length;
	return details.players
		.filter((other) => other.subject.toLowerCase() !== me && other.role !== "coach")
		.filter((other) => freeForAll || other.teamId !== player.teamId)
		.map((other) => {
			const them = other.subject.toLowerCase();
			const out = pairs.get(`${me}>${them}`);
			const back = pairs.get(`${them}>${me}`);
			const openings = details.duels!.openings;
			return {
				player: other,
				kills: out?.kills ?? 0,
				deaths: back?.kills ?? 0,
				dealt: out?.damage ?? 0,
				taken: back?.damage ?? 0,
				openingsWon: openings.filter((opening) => opening.killer === me && opening.victim === them).length,
				openingsLost: openings.filter((opening) => opening.killer === them && opening.victim === me).length,
			};
		});
};

const RESULT_TONE = {
	won: "border-(--signal-pos)/40 text-(--signal-pos)",
	lost: "border-(--signal-neg)/40 text-(--signal-neg)",
	even: "border-(--border) text-(--text-secondary)",
} as const;

export const MatchPlayerDuels = ({
	details,
	player,
	assets,
}: {
	details: MatchDetails;
	player: MatchPlayer;
	assets: MatchAssets;
}) => {
	const { t, i18n } = useTranslation();
	const lines = matchDuels(details, player);
	const number = (value: number) => value.toLocaleString(i18n.language);

	return (
		<section aria-label={t("matches.duels")} className="flex flex-col gap-1">
			<h4 className="px-1 text-[11px] font-semibold text-(--text-secondary)">{t("matches.duels")}</h4>
			{!lines ? (
				<p className="px-1 text-[11px] text-(--text-muted)">{t("matches.duelsUnavailable")}</p>
			) : lines.length === 0 ? (
				<p className="px-1 text-[11px] text-(--text-muted)">{t("matches.duelsNone")}</p>
			) : (
				<ul className="flex flex-col">
					{lines.map((line) => {
						const agent = assets.agents.get(line.player.characterId.toLowerCase());
						const result = line.kills > line.deaths ? "won" : line.kills < line.deaths ? "lost" : "even";
						const hasOpenings = line.openingsWon + line.openingsLost > 0;
						return (
							<li
								key={line.player.subject}
								className="flex items-center gap-2.5 rounded-[6px] px-1 py-1 text-[11px] tabular-nums text-(--text-muted)"
							>
								{agent?.icon ? (
									<img src={agent.icon} alt={localize(agent.name)} title={localize(agent.name)} className="size-5 shrink-0 rounded-[4px]" />
								) : (
									<span className="size-5 shrink-0 rounded-[4px] bg-(--control)" />
								)}
								<span className="min-w-0 flex-1 truncate">
									<span className="font-semibold text-(--text-primary)">{line.player.gameName || "—"}</span>
									{line.player.tagLine && <span>#{line.player.tagLine}</span>}
								</span>
								<span
									className={`flex w-[5.5rem] shrink-0 items-center justify-center gap-1 rounded-[4px] border px-1 font-semibold ${RESULT_TONE[result]}`}
									title={t(`matches.duel_${result}`)}
								>
									{line.kills}:{line.deaths}
									<span className="font-normal">{t(`matches.duel_${result}`)}</span>
								</span>
								<span className="w-32 shrink-0 text-right" title={t("matches.duelDamageHint")}>
									{t("matches.duelDamage")} <span className="text-(--text-secondary)">{number(line.dealt)}:{number(line.taken)}</span>
								</span>
								<span className="w-24 shrink-0 text-right" title={t("matches.duelOpeningsHint")}>
									{hasOpenings ? (
										<>
											{t("matches.duelOpenings")}{" "}
											<span className="text-(--text-secondary)">
												{line.openingsWon}:{line.openingsLost}
											</span>
										</>
									) : (
										"—"
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
};
