import type { ReactNode } from "react";

/**
 * Sidebar for the History tab: which room of a saved match to read (Team or
 * All), above the saved-match list it is given.
 */
export const ChatHistoryPanel = ({
	title,
	owner,
	room,
	onRoomChange,
	labels,
	children,
}: {
	title: string;
	/** Riot ID of the account this saved history belongs to, once known. */
	owner?: string;
	room: "team" | "all";
	onRoomChange: (room: "team" | "all") => void;
	labels: { team: string; all: string; room: string; owner: string };
	children: ReactNode;
}) => (
	<aside aria-label={title} data-chat-history-panel="" className="flex w-[268px] shrink-0 flex-col border-r border-(--line) bg-(--panel)">
		<div className="shrink-0 px-3 pb-1 pt-3">
			<h2 className="text-[13px] font-semibold text-(--text-primary)">{title}</h2>
			{owner && (
				<p data-history-owner="" className="mt-0.5 truncate text-[11px] text-(--text-muted)" title={owner}>
					{labels.owner} <span className="font-medium text-(--text-secondary)">{owner}</span>
				</p>
			)}
			<div role="radiogroup" aria-label={labels.room} className="mt-2 grid grid-cols-2 gap-0.5 rounded-[7px] border border-(--border) bg-(--control) p-0.5">
				{(["team", "all"] as const).map((id) => {
					const active = room === id;
					return (
						<button
							key={id}
							type="button"
							role="radio"
							aria-checked={active}
							onClick={() => onRoomChange(id)}
							className={`h-6 rounded-[5px] text-[11px] font-medium outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
								active ? "bg-(--surface) text-(--text-primary)" : "text-(--text-muted) hover:text-(--text-secondary)"
							}`}
						>
							{labels[id]}
						</button>
					);
				})}
			</div>
		</div>
		{children}
	</aside>
);
