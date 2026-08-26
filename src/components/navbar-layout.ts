/**
 * Class tokens for the command rail.
 *
 * Default items stay muted. The selected route uses a translucent purple wash
 * and a pale-purple icon so location is the only accent on the chrome.
 */
export const navbarLayout = {
	rail: "relative z-40 flex h-full w-16 min-w-16 max-w-16 shrink-0 flex-col items-center overflow-visible border-r border-(--border-subtle) bg-(--sidebar) px-2 py-3",
	railMark: "grid h-11 w-11 shrink-0 place-items-center opacity-80",
	railNav: "flex min-h-0 w-full flex-1 flex-col items-center pt-3",
	railRoutes: "command-rail-scroll flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden",
	railBottom: "flex shrink-0 flex-col items-center border-t border-(--border-subtle) pt-3",
	railStatus: "mt-2 shrink-0",
	railButton: "group navbar-motion relative grid h-11 w-11 shrink-0 place-items-center rounded-[6px] border border-transparent text-[15px] outline-none transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]",
	railButtonActive: "bg-[rgba(128,100,233,0.15)] border-[rgba(128,100,233,0.2)] text-(--accent-selected)",
	railButtonInactive: "text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary)",
	railSelectionMarker: "absolute left-0 h-4 w-0.5 rounded-full bg-(--accent)",
	railIcon: "grid h-[15px] w-[15px] place-items-center",
	tooltip: "navbar-motion pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-[6px] border border-(--border) bg-(--surface) px-2.5 py-1.5 text-[11px] font-medium text-(--text-primary) shadow-[0_8px_24px_rgba(0,0,0,0.28)] transition-[opacity,transform] duration-100",
	tooltipVisible: "translate-x-0 opacity-100",
	tooltipHidden: "translate-x-1 opacity-0",
	statusTooltip: "navbar-motion pointer-events-none absolute left-full top-1/2 z-[60] ml-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-[6px] border border-(--border) bg-(--surface) px-2.5 py-1.5 text-[11px] font-medium text-(--text-primary) opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.28)] transition-[opacity,transform] duration-100 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100",
	statusTrigger: "flex h-10 max-w-56 items-center gap-2 rounded-[6px] border border-transparent px-2 text-[12px] text-(--text-secondary) transition-colors hover:border-(--border) hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]",
	statusTriggerCompact: "group navbar-motion relative grid h-11 w-11 place-items-center rounded-[6px] border border-transparent text-(--text-muted) outline-none transition-[color,background-color,border-color,box-shadow] duration-150 hover:border-(--border) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]",
	statusMenu: "absolute right-0 top-11 z-50 w-60 max-w-[calc(100vw-1rem)] rounded-[8px] border border-(--border) bg-(--surface) p-1 shadow-[0_8px_24px_rgba(0,0,0,0.28)]",
	statusMenuCompact: "absolute bottom-0 left-full z-50 ml-3 w-60 max-w-[calc(100vw-5rem)] rounded-[8px] border border-(--border) bg-(--surface) p-1 shadow-[0_8px_24px_rgba(0,0,0,0.28)]",
	statusMessage: "mt-1 whitespace-normal break-words border-t border-(--line) px-2.5 pt-2 text-[11px] leading-4",
} as const;
