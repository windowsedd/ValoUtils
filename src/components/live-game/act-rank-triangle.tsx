import { useId } from "react";
import {
	ACT_RANK_CANVAS_SIZE,
	actRankCrystalCellBounds,
	borderIndexForWins,
	buildActRankTiles,
	buildLatticeCells,
	frameInnerTrianglePoints,
	innerTrianglePoints,
} from "./act-rank";

type Props = {
	winsByTier: Record<string, number>;
	wins: number;
};

const asPercentage = (value: number) => `${(value / ACT_RANK_CANVAS_SIZE) * 100}%`;
const asPoints = (points: readonly (readonly [number, number])[]) =>
	points.map(([x, y]) => `${x},${y}`).join(" ");
const safeSvgId = (prefix: string, id: string) =>
	`${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

export const ActRankTriangle = ({ winsByTier, wins }: Props) => {
	const reactId = useId();
	const tiles = buildActRankTiles(winsByTier, wins);
	const border = borderIndexForWins(wins);
	const borderMaskId = safeSvgId("act-rank-border-mask", reactId);
	const framePoints = frameInnerTrianglePoints();
	const contentPoints = innerTrianglePoints();
	const latticeCells = buildLatticeCells();

	return (
		<div
			className="relative mx-auto aspect-square w-full max-w-[24rem]"
			aria-hidden="true"
		>
			<img
				src={`/mmr/border${border}.png`}
				alt=""
				className="pointer-events-none absolute inset-0 z-0 h-full w-full object-contain"
			/>
			<svg
				viewBox={`0 0 ${ACT_RANK_CANVAS_SIZE} ${ACT_RANK_CANVAS_SIZE}`}
				className="pointer-events-none absolute inset-0 z-[1] h-full w-full"
				preserveAspectRatio="xMidYMid meet"
			>
				<polygon data-act-rank-mask="" points={asPoints(framePoints)} fill="#020304" />
				<polygon points={asPoints(contentPoints)} fill="#020304" />
				<g data-act-rank-lattice="" fill="none" stroke="#343a40" strokeWidth="0.75">
					{latticeCells.map((cell) => (
						<polygon key={`${cell.row}-${cell.column}`} points={asPoints(cell.points)} />
					))}
				</g>
			</svg>
			{tiles.map((tile, index) => {
				const position = actRankCrystalCellBounds(tile.row, tile.column);
				return (
					<img
						key={`${tile.tier}-${index}`}
						src={`/mmr/${tile.tier}_${tile.orientation}.png`}
						alt=""
						data-rank-cell=""
						className="absolute z-[2] object-fill"
						style={{
							left: asPercentage(position.left),
							top: asPercentage(position.top),
							width: asPercentage(position.width),
							height: asPercentage(position.height),
						}}
					/>
				);
			})}
			<svg
				data-act-rank-border=""
				className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
				viewBox={`0 0 ${ACT_RANK_CANVAS_SIZE} ${ACT_RANK_CANVAS_SIZE}`}
				preserveAspectRatio="xMidYMid meet"
			>
				<defs>
					<mask id={borderMaskId} maskUnits="userSpaceOnUse">
						<rect width={ACT_RANK_CANVAS_SIZE} height={ACT_RANK_CANVAS_SIZE} fill="white" />
						<polygon points={asPoints(framePoints)} fill="black" />
					</mask>
				</defs>
				<image
					href={`/mmr/border${border}.png`}
					width={ACT_RANK_CANVAS_SIZE}
					height={ACT_RANK_CANVAS_SIZE}
					mask={`url(#${borderMaskId})`}
				/>
			</svg>
		</div>
	);
};
