import { Fragment, useId } from "react";
import {
	actRankCellPoints,
	actRankPalette,
	buildActRankTiles,
	buildLatticeCells,
	innerTrianglePoints,
	outerTrianglePoints,
	type Point,
} from "./act-rank";

type Props = {
	winsByTier: Record<string, number>;
	wins: number;
};

const polygonPoints = (value: readonly Point[]) =>
	value.map(([x, y]) => `${x},${y}`).join(" ");

const centroid = (cell: readonly [Point, Point, Point]): Point => [
	(cell[0][0] + cell[1][0] + cell[2][0]) / 3,
	(cell[0][1] + cell[1][1] + cell[2][1]) / 3,
];

export const ActRankTriangle = ({ winsByTier }: Props) => {
	const id = useId().replaceAll(":", "");
	const outer = outerTrianglePoints();
	const inner = innerTrianglePoints();
	const tiles = buildActRankTiles(winsByTier);
	const palettes = [
		...new Map(
			tiles.map((tile) => {
				const palette = actRankPalette(tile.tier);
				return [palette.name, palette] as const;
			}),
		).values(),
	];

	return (
		<div className="mx-auto w-full max-w-[20rem]" aria-hidden="true">
			<svg
				className="block h-auto w-full"
				viewBox="0 0 300 360"
				preserveAspectRatio="xMidYMid meet"
			>
				<defs>
					<clipPath id={`${id}-inner`}>
						<polygon points={polygonPoints(inner)} />
					</clipPath>
					{palettes.map((palette) => (
						<Fragment key={palette.name}>
							<linearGradient
								id={`${id}-${palette.name}-light`}
								x1="0%"
								y1="0%"
								x2="100%"
								y2="100%"
							>
								<stop offset="0%" stopColor={palette.light} />
								<stop offset="100%" stopColor={palette.base} />
							</linearGradient>
							<linearGradient
								id={`${id}-${palette.name}-base`}
								x1="0%"
								y1="0%"
								x2="0%"
								y2="100%"
							>
								<stop offset="0%" stopColor={palette.base} />
								<stop offset="100%" stopColor={palette.dark} />
							</linearGradient>
							<linearGradient
								id={`${id}-${palette.name}-dark`}
								x1="100%"
								y1="0%"
								x2="0%"
								y2="100%"
							>
								<stop offset="0%" stopColor={palette.base} />
								<stop offset="100%" stopColor={palette.dark} />
							</linearGradient>
						</Fragment>
					))}
				</defs>

				<polygon
					points={polygonPoints(outer)}
					fill="#080a0d"
					stroke="#30353b"
					strokeWidth="12"
					strokeLinejoin="round"
				/>
				<polygon
					points={polygonPoints(inner)}
					fill="#0b0e12"
					stroke="#9199a2"
					strokeWidth="2"
					strokeLinejoin="round"
				/>

				<g clipPath={`url(#${id}-inner)`}>
					{buildLatticeCells().map((cell) => (
						<polygon
							key={`${cell.row}-${cell.column}`}
							points={polygonPoints(cell.points)}
							fill="none"
							stroke="#252a31"
							strokeWidth="0.7"
							strokeLinejoin="round"
						/>
					))}

					{tiles.map((tile, index) => {
						const cell = actRankCellPoints(tile.row, tile.column);
						const center = centroid(cell);
						const palette = actRankPalette(tile.tier);
						return (
							<g
								key={`${tile.tier}-${index}`}
								data-rank-cell=""
								data-palette={palette.name}
							>
								<polygon
									points={polygonPoints([cell[0], cell[1], center])}
									fill={`url(#${id}-${palette.name}-light)`}
								/>
								<polygon
									points={polygonPoints([cell[1], cell[2], center])}
									fill={`url(#${id}-${palette.name}-base)`}
								/>
								<polygon
									points={polygonPoints([cell[2], cell[0], center])}
									fill={`url(#${id}-${palette.name}-dark)`}
								/>
								<polygon
									points={polygonPoints(cell)}
									fill="none"
									stroke={palette.edge}
									strokeWidth="1.1"
									strokeLinejoin="round"
								/>
							</g>
						);
					})}
				</g>
			</svg>
		</div>
	);
};
