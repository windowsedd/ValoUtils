import { borderIndexForWins, buildActRankTiles } from "./act-rank";

const TILE_WIDTH = 24.4140625;
const TILE_HEIGHT = 21.6796875;
const FIRST_ROW_TOP = 29.6875;

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
				const rowWidth = TILE_WIDTH * (tile.row + 1);
				const left = 50 - rowWidth / 2 + (tile.column * TILE_WIDTH) / 2;
				const top = FIRST_ROW_TOP + (tile.row * TILE_HEIGHT) / 2;
				return (
					<img
						key={`${tile.tier}-${index}`}
						src={`/mmr/${tile.tier}_${tile.orientation}.png`}
						alt=""
						className="absolute object-fill"
						style={{
							left: `${left}%`,
							top: `${top}%`,
							width: `${TILE_WIDTH}%`,
							height: `${TILE_HEIGHT}%`,
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
