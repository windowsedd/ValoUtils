import { Children, useState, type ReactNode } from "react";
import { LuChevronDown } from "react-icons/lu";

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
 *
 * `collapsible` turns the header into a disclosure button. It is opt-in so the
 * pages that want a plain panel keep one. A collapsed card does not render its
 * body at all rather than hiding it with CSS — Inventory stacks a card per
 * weapon, and mounting every skin row of every closed card is work no one sees.
 */
export const SectionCard = ({
	title,
	accent = "#8064e9",
	count,
	right,
	children,
	className = "",
	collapsible = false,
	defaultOpen = true,
}: {
	title: string;
	accent?: string;
	count?: number;
	right?: ReactNode;
	children: ReactNode;
	className?: string;
	collapsible?: boolean;
	defaultOpen?: boolean;
}) => {
	const [open, setOpen] = useState(defaultOpen);
	const shown = !collapsible || open;
	const label = (
		<div className="flex min-w-0 items-center gap-2">
			<span aria-hidden="true" className="h-3 w-0.5 shrink-0 rounded-full" style={{ background: accent }} />
			<h2 className="truncate text-[12px] font-medium text-(--text-primary)">
				{title}
			</h2>
		</div>
	);
	const meta = (
		<div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-(--text-muted)">
			{right ?? (typeof count === "number" ? count : null)}
			{collapsible && (
				<LuChevronDown
					aria-hidden="true"
					className={`text-(--text-muted) transition-transform duration-150 motion-reduce:transition-none ${
						open ? "" : "-rotate-90"
					}`}
				/>
			)}
		</div>
	);
	// The hairline belongs to the seam between header and body, so a closed card
	// must not keep it — it would read as a rule under nothing.
	const rule = shown ? "border-b border-(--line)" : "";

	return (
		<section className={`panel ${className}`}>
			{collapsible ? (
				<button
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-(--surface-hover) motion-reduce:transition-none ${rule}`}
				>
					{label}
					{meta}
				</button>
			) : (
				<header className={`flex items-center justify-between gap-3 px-3 py-2 ${rule}`}>
					{label}
					{meta}
				</header>
			)}
			{shown && <div className="flex flex-col px-1.5 py-1.5">{children}</div>}
		</section>
	);
};

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
			className={`readout gap-3 rounded-[6px] px-2.5 py-2 transition-colors duration-150 ${
				muted ? "hover:bg-(--surface-hover)" : "hover:bg-(--surface-hover)"
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
 * Scroll body under PageHeader. Top padding keeps the first panel off the
 * header hairline.
 */
export const pageBodyClass =
	"flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-4 pb-6";

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
			<span className="self-center text-(--text-secondary) [&_svg]:text-(--text-secondary)">{icon}</span>
			<h1 className="truncate text-[13px] font-semibold text-(--text-primary)">{title}</h1>
			{subtitle && <span className="truncate text-[11px] text-(--text-muted)">{subtitle}</span>}
		</div>
		{children && <div className="flex shrink-0 items-center gap-3">{children}</div>}
	</div>
);
