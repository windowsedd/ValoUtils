/**
 * Class tokens for the command rail.
 *
 * A floating dock: a rounded surface column inset from the window edge, beside
 * the page sheet. Inactive routes are muted outlines; the selected route is a
 * solid accent tile with a light glyph, so location reads at a glance and is
 * the only saturated thing on the chrome. The fill itself is the selection
 * marker — there is no separate tick.
 */
export const navbarLayout = {
  rail: "relative z-40 flex h-full w-16 min-w-16 max-w-16 shrink-0 flex-col overflow-visible py-2.5 pl-2.5",
  dock: "flex min-h-0 w-full flex-1 flex-col items-center rounded-[16px] border border-(--border) bg-(--surface) py-3",
  railMark: "grid h-9 w-9 shrink-0 place-items-center opacity-90",
  railNav: "flex min-h-0 w-full flex-1 flex-col items-center pt-3",
  railRoutes:
    "command-rail-scroll flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden",
  railBottom: "mt-2 flex w-full shrink-0 flex-col items-center gap-1.5 border-t border-(--line) pt-2.5",
  railStatus: "mt-2 shrink-0",
  railButton:
    "press-tile group navbar-motion relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[12px] border border-transparent text-[17px] outline-none transition-[color,background-color,border-color,box-shadow,scale] duration-150 focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]",
  railButtonActive:
    "bg-(--accent) text-(--accent-foreground) shadow-[0_4px_16px_rgba(128,100,233,0.35)]",
  railButtonInactive: "text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary)",
  railIcon: "grid h-[18px] w-[18px] place-items-center",
  tooltip:
    "navbar-motion pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-[6px] border border-(--border) bg-(--surface) px-2.5 py-1.5 text-[11px] font-medium text-(--text-primary) shadow-[0_8px_24px_rgba(0,0,0,0.28)] transition-[opacity,transform] duration-100",
  tooltipVisible: "translate-x-0 opacity-100",
  tooltipHidden: "translate-x-1 opacity-0",
  statusTooltip:
    "navbar-motion pointer-events-none absolute left-full top-1/2 z-[60] ml-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-[6px] border border-(--border) bg-(--surface) px-2.5 py-1.5 text-[11px] font-medium text-(--text-primary) opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.28)] transition-[opacity,transform] duration-100 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100",
  statusTrigger:
    "press-flat flex h-10 max-w-56 items-center gap-2 rounded-[6px] border border-transparent px-2 text-[12px] text-(--text-secondary) transition-colors hover:border-(--border) hover:bg-(--surface-hover) focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]",
  statusTriggerCompact:
    "press-flat group navbar-motion relative grid h-[38px] w-[38px] place-items-center rounded-[12px] border border-transparent text-(--text-muted) outline-none transition-[color,background-color,border-color,box-shadow] duration-150 hover:border-(--border) hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]",
  statusMenu:
    "absolute right-0 top-11 z-50 w-64 max-w-[calc(100vw-1rem)] rounded-[14px] border border-(--border) bg-(--surface) p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)]",
  statusMenuCompact:
    "absolute bottom-0 left-full z-50 ml-4 w-64 max-w-[calc(100vw-5rem)] rounded-[14px] border border-(--border) bg-(--surface) p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)]",
  statusMessage:
    "mt-2 flex gap-2 whitespace-normal break-words rounded-[10px] border px-2.5 py-2 text-[11px] leading-4",
} as const;
