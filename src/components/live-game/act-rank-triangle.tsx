import { actRankTileStyle, borderIndexForWins, buildActRankTiles } from "./act-rank";

export const ActRankTriangle = ({
	winsByTier,
	wins,
}: {
	winsByTier: Record<string, number>;
	wins: number;
}) => {
	const tiles = buildActRankTiles(winsByTier);
	const border = borderIndexForWins(wins);

	return (
		<div className="relative mx-auto aspect-square w-full max-w-[24rem]" aria-hidden="true">
			{tiles.map((tile, index) => {
				const style = actRankTileStyle(tile);
				return (
					<img
						key={`${tile.tier}-${index}`}
						src={`/mmr/${tile.tier}_${tile.orientation}.png`}
						alt=""
						className="absolute object-fill"
						style={{
							left: `${style.left}%`,
							top: `${style.top}%`,
							width: `${style.width}%`,
							height: `${style.height}%`,
						}}
					/>
				);
			})}
			<img
				src={`/mmr/border${border}.png`}
				alt=""
				className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
			/>
		</div>
	);
};
