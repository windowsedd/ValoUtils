import {
	ACT_RANK_CANVAS_SIZE,
	actRankCellBounds,
	borderIndexForWins,
	buildActRankTiles,
} from "./act-rank";

type Props = {
	winsByTier: Record<string, number>;
	wins: number;
};

const asPercentage = (value: number) => `${(value / ACT_RANK_CANVAS_SIZE) * 100}%`;

export const ActRankTriangle = ({ winsByTier, wins }: Props) => {
	const tiles = buildActRankTiles(winsByTier, wins);
	const border = borderIndexForWins(wins);

	return (
		<div
			className="relative mx-auto aspect-square w-full max-w-[24rem]"
			aria-hidden="true"
		>
			{tiles.map((tile, index) => {
				const position = actRankCellBounds(tile.row, tile.column);
				return (
					<img
						key={`${tile.tier}-${index}`}
						src={`/mmr/${tile.tier}_${tile.orientation}.png`}
						alt=""
						data-rank-cell=""
						className="absolute object-fill"
						style={{
							left: asPercentage(position.left),
							top: asPercentage(position.top),
							width: asPercentage(position.width),
							height: asPercentage(position.height),
						}}
					/>
				);
			})}
			<img
				src={`/mmr/border${border}.png`}
				alt=""
				data-act-rank-border=""
				className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
			/>
		</div>
	);
};
