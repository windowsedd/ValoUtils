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
	id,
	title,
	accent = "#8064e9",
	count,
	right,
	children,
	className = "",
	collapsible = false,
	defaultOpen = true,
}: {
	id?: string;
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
			<h2 className="truncate text-[12px] font-semibold text-(--text-primary)">
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
	const rule = shown ? "rounded-t-[12px] border-b border-(--line)" : "rounded-[12px]";

	return (
		<section id={id} className={`scroll-mt-5 rounded-[12px] border border-(--border) bg-(--surface) ${className}`}>
			{collapsible ? (
				<button
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-(--surface-hover) motion-reduce:transition-none ${rule}`}
				>
					{label}
					{meta}
				</button>
			) : (
				<header className={`flex items-center justify-between gap-3 px-4 py-2.5 ${rule}`}>
					{label}
					{meta}
				</header>
			)}
			{shown && <div className="flex flex-col p-2">{children}</div>}
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
			className={`readout gap-3 rounded-[8px] px-3 py-2 transition-colors duration-150 ${
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
	"flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 pt-5 pb-6";

/**
 * Page header at the top of the sheet: an accent icon tile, the page name with
 * an optional muted subtitle beneath it, actions on the right, and optional
 * underline tabs riding the bottom hairline.
 */
export const PageHeader = ({
	icon,
	title,
	subtitle,
	tabs,
	children,
}: {
	icon: ReactNode;
	title: string;
	subtitle?: string;
	tabs?: ReactNode;
	children?: ReactNode;
}) => (
	<header className="shrink-0 border-b border-(--line)">
		<div className={`flex items-center justify-between gap-4 px-6 pt-4 ${tabs ? "pb-2" : "pb-3.5"}`}>
			<div className="flex min-w-0 items-center gap-3">
				<span
					aria-hidden="true"
					className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-(--accent-border) bg-(--accent-soft) text-(--accent-selected) [&_svg]:text-[16px]"
				>
					{icon}
				</span>
				<div className="min-w-0">
					<h1 className="truncate text-[16px] leading-tight font-semibold text-(--text-primary)">{title}</h1>
					{subtitle && <p className="mt-0.5 truncate text-[11px] text-(--text-muted)">{subtitle}</p>}
				</div>
			</div>
			{children && <div className="flex shrink-0 items-center gap-2.5">{children}</div>}
		</div>
		{tabs}
	</header>
);

/**
 * Underline tabs for the PageHeader `tabs` slot. The active tab is marked by
 * an accent rule sitting on the header hairline.
 */
export const PageTabs = <T extends string>({
	tabs,
	value,
	onChange,
	label,
}: {
	tabs: { id: T; label: string; icon?: ReactNode }[];
	value: T | null;
	onChange: (id: T) => void;
	label: string;
}) => (
	<div role="tablist" aria-label={label} className="command-rail-scroll flex gap-5 overflow-x-auto px-6">
		{tabs.map((tab) => {
			const active = tab.id === value;
			return (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={active}
					data-page-tab={tab.id}
					onClick={() => onChange(tab.id)}
					className={`page-tab press-flat relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium outline-none transition-colors duration-150 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:text-(--text-primary) ${
						active
							? "text-(--text-primary) after:bg-(--accent)"
							: "text-(--text-muted) after:bg-transparent hover:text-(--text-secondary)"
					}`}
				>
					{tab.icon && <span className="text-[13px] [&_svg]:block">{tab.icon}</span>}
					{tab.label}
				</button>
			);
		})}
	</div>
);

/**
 * Two-pane page body: a fixed summary column on the left and a scrolling main
 * column. Use under PageHeader in place of a single pageBodyClass body.
 */
export const PageSplit = ({ aside, children }: { aside: ReactNode; children: ReactNode }) => (
	<div className="flex min-h-0 flex-1 overflow-hidden" data-page-split="">
		<aside className="flex w-[17rem] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-(--line) px-5 pt-5 pb-6">
			{aside}
		</aside>
		<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 pt-5 pb-6">{children}</div>
	</div>
);
