import type { ReactNode } from "react";

/**
 * The card that carries every list in the app — Friends, Replays, Profiles,
 * Competitive. One definition so the pages can't drift apart.
 *
 * Anatomy: a glass card, an uppercase accent-coloured eyebrow naming the group,
 * and a right slot that defaults to the item count. Rows go in the body with a
 * consistent 6px gutter; use `<SectionRow>` for the standard row shell.
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
	<section className={`glass rounded-2xl px-4 py-4 ${className}`}>
		<header className="flex items-center justify-between gap-3 px-1 mb-3">
			<h2 className="text-xs font-bold uppercase tracking-widest truncate" style={{ color: accent }}>
				{title}
			</h2>
			<div className="shrink-0 text-xs text-gray-600 tabular-nums">
				{right ?? (typeof count === "number" ? count : null)}
			</div>
		</header>
		<div className="flex flex-col gap-1.5">{children}</div>
	</section>
);

/** Standard row inside a SectionCard. `muted` drops the fill for nested rows. */
export const SectionRow = ({
	children,
	muted = false,
	className = "",
}: { children: ReactNode; muted?: boolean; className?: string }) => (
	<div
		className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
			muted ? "hover:bg-white/4" : "bg-white/2 hover:bg-white/6"
		} ${className}`}
	>
		{children}
	</div>
);

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
	<div className="shrink-0 px-6 pt-5 pb-3 flex items-center justify-between gap-4">
		<div className="flex items-center gap-2 min-w-0">
			{icon}
			<span className="text-white font-semibold truncate">{title}</span>
			{subtitle && <span className="text-gray-500 text-sm truncate">{subtitle}</span>}
		</div>
		{children && <div className="flex items-center gap-3 shrink-0">{children}</div>}
	</div>
);
