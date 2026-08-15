import { Children, type ReactNode } from "react";

/**
 * The card that carries every list in the app — Friends, Profiles, Matches,
 * Competitive. One definition so the pages can't drift apart.
 *
 * Anatomy: a flat panel, a hairline-ruled header with a micro label naming the
 * group, and a right slot that defaults to the item count. Rows go in the body.
 *
 * `accent` is a marker, not paint. It renders as a short tick beside the label
 * and never colors the type — a tier color says something, a section color
 * doesn't, and the component can't tell them apart, so it whispers either way.
 */
export const SectionCard = ({
	title,
	accent = "#ff4655",
	count,
	right,
	children,
	className = "",
}: {
	title: string;
	accent?: string;
	count?: number;
	right?: ReactNode;
	children: ReactNode;
	className?: string;
}) => (
	<section className={`panel ${className}`}>
		<header className="flex items-center justify-between gap-3 border-b border-(--line) px-3 py-2">
			<div className="flex min-w-0 items-center gap-2">
				<span aria-hidden="true" className="h-3 w-0.5 shrink-0" style={{ background: accent }} />
				<h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-(--ink-dim)">
					{title}
				</h2>
			</div>
			<div className="shrink-0 text-xs tabular-nums text-(--ink-faint)">
				{right ?? (typeof count === "number" ? count : null)}
			</div>
		</header>
		<div className="flex flex-col px-1.5 py-1.5">{children}</div>
	</section>
);

/**
 * Standard row inside a SectionCard.
 *
 * A row given exactly two children is treated as a readout — label, dotted
 * leader, value — which is the app's signature device. Pass `leader={false}` for
 * rows that aren't a name/value pair. `muted` drops the hover fill for nested rows.
 */
export const SectionRow = ({
	children,
	muted = false,
	leader = true,
	className = "",
}: { children: ReactNode; muted?: boolean; leader?: boolean; className?: string }) => {
	const items = Children.toArray(children);
	const isReadout = leader && items.length === 2;

	return (
		<div
			className={`readout gap-3 rounded-sm px-2.5 py-2 transition-colors ${
				muted ? "hover:bg-white/4" : "hover:bg-white/[0.035]"
			} ${className}`}
		>
			{isReadout ? (
				<>
					{items[0]}
					<span aria-hidden="true" className="readout-leader" />
					{items[1]}
				</>
			) : (
				children
			)}
		</div>
	);
};

/**
 * Page header used above the section stack: an accent icon, the page name, and
 * an optional muted subtitle, with actions pushed to the right.
 */
export const PageHeader = ({
	icon,
	title,
	subtitle,
	children,
}: { icon: ReactNode; title: string; subtitle?: string; children?: ReactNode }) => (
	<div className="shrink-0 flex items-center justify-between gap-4 border-b border-(--line) px-6 py-3">
		<div className="flex min-w-0 items-baseline gap-2.5">
			{/* Forces page icons to ink even when the call site hands them a hue —
			    an icon that's always red isn't telling you anything. */}
			<span className="self-center text-(--ink-dim) [&_svg]:text-(--ink-dim)">{icon}</span>
			<h1 className="truncate text-[15px] font-semibold text-(--ink)">{title}</h1>
			{subtitle && <span className="truncate text-sm text-(--ink-faint)">{subtitle}</span>}
		</div>
		{children && <div className="flex shrink-0 items-center gap-3">{children}</div>}
	</div>
);
