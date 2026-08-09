import type { LivePlayer, WeaponSkin } from "@/types/live-game";
import {
	getAgents,
	getMaps,
	getPlayerCard,
	getSeasonLabels,
	getTiers,
	getWeaponSkin,
	weaponSkinKey,
	type AgentAsset,
	type CardAsset,
	type MapAsset,
	type SkinAsset,
	type TierAsset,
} from "@/util/valorant-assets";
import { useEffect, useState } from "react";

export type LiveGameAssets = {
	agents: Map<string, AgentAsset>;
	tiers: Map<number, TierAsset>;
	maps: Map<string, MapAsset>;
	seasons: Map<string, string>;
	skins: Map<string, SkinAsset | null>;
	cards: Map<string, CardAsset | null>;
};

async function pooled<T>(tasks: (() => Promise<T>)[], concurrency = 4): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await tasks[index]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results;
}

export const useLiveGameAssets = (players: LivePlayer[]): LiveGameAssets => {
	const [assets, setAssets] = useState<LiveGameAssets>({
		agents: new Map(),
		tiers: new Map(),
		maps: new Map(),
		seasons: new Map(),
		skins: new Map(),
		cards: new Map(),
	});

	useEffect(() => {
		let cancelled = false;
		Promise.all([getAgents(), getTiers(), getMaps(), getSeasonLabels()]).then(
			([agents, tiers, maps, seasons]) => {
				if (!cancelled) setAssets((current) => ({ ...current, agents, tiers, maps, seasons }));
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		const weapons: WeaponSkin[] = [];
		for (const player of players) {
			if (player.loadout) weapons.push(player.loadout.vandal, player.loadout.phantom, player.loadout.knife);
		}
		const uniqueWeapons = [...new Map(weapons.filter(Boolean).map((weapon) => [weaponSkinKey(weapon), weapon])).values()];
		pooled(
			uniqueWeapons.map((weapon) => () =>
				getWeaponSkin(weapon).then((asset) => [weaponSkinKey(weapon)!, asset] as const),
			),
		).then((entries) => {
			if (cancelled) return;
			setAssets((current) => {
				const skins = new Map(current.skins);
				for (const [key, asset] of entries) skins.set(key, asset);
				return { ...current, skins };
			});
		});

		const cardIds = [...new Set(players.map((player) => player.cardId).filter(Boolean) as string[])];
		pooled(cardIds.map((id) => () => getPlayerCard(id).then((asset) => [id.toLowerCase(), asset] as const))).then(
			(entries) => {
				if (cancelled) return;
				setAssets((current) => {
					const cards = new Map(current.cards);
					for (const [key, asset] of entries) cards.set(key, asset);
					return { ...current, cards };
				});
			},
		);
		return () => {
			cancelled = true;
		};
	}, [players]);

	return assets;
};
