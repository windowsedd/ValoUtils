/**
 * Class tokens for the command rail.
 *
 * The rail is chrome, so it holds no color. Selection reads as a bone-white
 * block against graphite — the loudest thing on screen is where you are, not the
 * brand. Red is reserved for destructive and enemy states elsewhere in the app.
 */
export const navbarLayout = {
	rail: "relative z-40 flex h-full w-16 min-w-16 max-w-16 shrink-0 flex-col items-center overflow-visible border-r border-(--line) bg-(--panel) px-2 py-3",
	railMark: "grid h-11 w-11 shrink-0 place-items-center opacity-80",
	railNav: "flex min-h-0 w-full flex-1 flex-col items-center pt-3",
	railRoutes: "command-rail-scroll flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden",
	railBottom: "flex shrink-0 flex-col items-center border-t border-(--line) pt-3",
	railStatus: "mt-2 shrink-0",
	railButton: "group navbar-motion relative grid h-11 w-11 shrink-0 place-items-center rounded-sm text-base outline-none transition-[color,background-color] duration-150 focus-visible:ring-1 focus-visible:ring-(--signal-focus)",
	railButtonActive: "bg-(--ink) text-(--ground)",
	railButtonInactive: "text-(--ink-faint) hover:bg-white/5 hover:text-(--ink)",
	// Cut into the inverted block rather than sitting outside it — a registration
	// tick on the selected row, in the ground color so it reads as an absence.
	railSelectionMarker: "absolute left-0 h-5 w-0.5 bg-(--ground)",
	railIcon: "grid h-5 w-5 place-items-center",
	tooltip: "navbar-motion pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-sm border border-(--line-strong) bg-(--panel-raised) px-2.5 py-1.5 text-xs font-medium text-(--ink) shadow-lg transition-[opacity,transform] duration-100",
	tooltipVisible: "translate-x-0 opacity-100",
	tooltipHidden: "translate-x-1 opacity-0",
	statusTooltip: "navbar-motion pointer-events-none absolute left-full top-1/2 z-[60] ml-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-sm border border-(--line-strong) bg-(--panel-raised) px-2.5 py-1.5 text-xs font-medium text-(--ink) opacity-0 shadow-lg transition-[opacity,transform] duration-100 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100",
	statusTrigger: "flex h-10 max-w-56 items-center gap-2 rounded-sm border border-transparent px-2 text-sm text-(--ink-dim) transition-colors hover:border-(--line) hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--signal-focus)",
	statusTriggerCompact: "group navbar-motion relative grid h-11 w-11 place-items-center rounded-sm border border-transparent text-(--ink-faint) outline-none transition-[color,background-color,border-color] duration-150 hover:border-(--line) hover:bg-white/5 hover:text-(--ink) focus-visible:ring-1 focus-visible:ring-(--signal-focus)",
	statusMenu: "absolute right-0 top-11 z-50 w-60 max-w-[calc(100vw-1rem)] rounded-sm border border-(--line-strong) bg-(--panel-raised) p-1 shadow-2xl",
	statusMenuCompact: "absolute bottom-0 left-full z-50 ml-3 w-60 max-w-[calc(100vw-5rem)] rounded-sm border border-(--line-strong) bg-(--panel-raised) p-1 shadow-2xl",
	statusMessage: "mt-1 whitespace-normal break-words border-t border-(--line) px-2.5 pt-2 text-[11px] leading-4",
} as const;
