export const navbarLayout = {
	root: "flex items-stretch w-full px-4 shrink-0 border-b border-divider",
	tabsViewport: "flex-1 min-w-0 overflow-x-auto overscroll-x-contain nav-tabs-scroll",
	tabsList: "gap-3 relative rounded-none p-0 border-b-0 w-max min-w-max",
	tab: "max-w-fit px-0 h-12 whitespace-nowrap shrink-0",
	status: "shrink-0 flex items-center ml-3 pl-3 border-l border-white/10",
	statusMenu: "absolute right-0 top-10 z-50 w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-white/10 bg-[#111318] p-1.5 shadow-2xl",
	statusMessage: "border-t border-white/10 px-2.5 pt-2 mt-1 text-[11px] leading-4 whitespace-normal break-words",
} as const;
