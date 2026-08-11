import { useId } from "react";
import {
	actRankCellPoints,
	ACT_RANK_GEOMETRY,
	borderIndexForWins,
	buildActRankTiles,
	buildLatticeCells,
	innerTrianglePoints,
	type Point,
} from "./act-rank";

type Props = {
	winsByTier: Record<string, number>;
	wins: number;
};

const polygonPoints = (value: readonly Point[]) =>
	value.map(([x, y]) => `${x},${y}`).join(" ");

const imageBounds = (points: readonly Point[]) => {
	const xs = points.map(([x]) => x);
	const ys = points.map(([, y]) => y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return {
		x,
		y,
		width: Math.max(...xs) - x,
		height: Math.max(...ys) - y,
	};
};

export const ActRankTriangle = ({ winsByTier, wins }: Props) => {
	const id = useId().replace(/:/g, "");
	const inner = innerTrianglePoints();
	const tiles = buildActRankTiles(winsByTier);
	const border = borderIndexForWins(wins);

	return (
		<div
			className="relative mx-auto aspect-square w-full max-w-[24rem]"
			aria-hidden="true"
		>
			<svg
				className="block h-full w-full"
				viewBox={`0 0 ${ACT_RANK_GEOMETRY.width} ${ACT_RANK_GEOMETRY.height}`}
				preserveAspectRatio="xMidYMid meet"
			>
				<defs>
					<clipPath id={`${id}-inner`}>
						<polygon points={polygonPoints(inner)} />
					</clipPath>
				</defs>

				<g clipPath={`url(#${id}-inner)`}>
					<polygon points={polygonPoints(inner)} fill="#0b0e12" />
					{buildLatticeCells().map((cell) => (
						<polygon
							key={`${cell.row}-${cell.column}`}
							points={polygonPoints(cell.points)}
							fill="none"
							stroke="#252a31"
							strokeWidth="0.8"
							strokeLinejoin="round"
						/>
					))}

					{tiles.map((tile, index) => {
						const bounds = imageBounds(actRankCellPoints(tile.row, tile.column));
						return (
							<image
								key={`${tile.tier}-${index}`}
								href={`/mmr/${tile.tier}_${tile.orientation}.png`}
								x={bounds.x}
								y={bounds.y}
								width={bounds.width}
								height={bounds.height}
								preserveAspectRatio="none"
								data-rank-cell=""
							/>
						);
					})}
				</g>
			</svg>
			<img
				src={`/mmr/border${border}.png`}
				alt=""
				data-act-rank-border=""
				className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
			/>
		</div>
	);
};
