import type { FriendConversation, FriendGameStatus } from "./chat-model";
import { formatClock } from "./chat-model";
import { FaMagnifyingGlass } from "react-icons/fa6";

export type FriendStatusLabels = Record<FriendGameStatus, string>;

const conversationInitial = (title: string) => {
	const name = title.split("#")[0]?.trim() || title.trim();
	return (name[0] ?? "?").toUpperCase();
};

export const ChatConversationList = ({
	conversations,
	selectedCid,
	statusLabels,
	search,
	searchLabel,
	emptyLabel,
	markAsReadLabel,
	onSearchChange,
	onSelect,
	onMarkRead,
}: {
	conversations: FriendConversation[];
	selectedCid: string | null;
	statusLabels: FriendStatusLabels;
	search: string;
	searchLabel: string;
	emptyLabel: string;
	markAsReadLabel: string;
	onSearchChange: (value: string) => void;
	onSelect: (cid: string) => void;
	onMarkRead: (cid: string) => void;
}) => (
	<aside className="flex w-[268px] shrink-0 flex-col border-r border-(--border-subtle) bg-(--sidebar)">
		<div className="px-2 pb-2 pt-4">
			<label className="flex h-8 items-center gap-2 rounded-[6px] border border-(--border) bg-(--control) px-2.5 text-(--text-muted) transition-[border-color,box-shadow] duration-150 focus-within:border-(--accent) focus-within:shadow-[0_0_0_2px_var(--accent-soft)]">
				<FaMagnifyingGlass aria-hidden="true" className="text-[12px]" />
				<span className="sr-only">{searchLabel}</span>
				<input
					type="search"
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder={searchLabel}
					className="min-w-0 flex-1 bg-transparent text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-muted)"
				/>
			</label>
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
			{conversations.length === 0 ? (
				<p className="px-3 py-8 text-center text-[12px] text-(--text-muted)">{emptyLabel}</p>
			) : (
				conversations.map((conversation) => {
					const selected = selectedCid === conversation.cid;
					return (
						<button
							key={conversation.cid}
							type="button"
							aria-current={selected || undefined}
							onClick={() => onSelect(conversation.cid)}
							className={`relative mb-0.5 flex w-full items-center gap-2.5 rounded-[8px] px-2 py-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
								selected
									? "bg-[rgba(128,100,233,0.15)]"
									: "hover:bg-(--surface-hover)"
							}`}
						>
							<span
								className={`grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-[11px] font-medium ${
									selected
										? "bg-(--accent-soft) text-(--accent-selected)"
										: "bg-(--control) text-(--text-secondary)"
								}`}
							>
								{conversationInitial(conversation.title)}
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex items-baseline gap-2">
									<span className="min-w-0 flex-1 truncate text-[12px] font-medium text-(--text-primary)">
										{conversation.title}
									</span>
									<span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-(--text-muted)">
										{formatClock(conversation.latestTime)}
									</span>
								</span>
								<span className="mt-0.5 flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-[11px] text-(--text-muted)">
										{statusLabels[conversation.statusKey]}
									</span>
									{conversation.unreadCount > 0 && (
										<button
											type="button"
											data-unread-count={conversation.unreadCount}
											aria-label={markAsReadLabel}
											title={markAsReadLabel}
											onClick={(event) => {
												event.stopPropagation();
												onMarkRead(conversation.cid);
											}}
											className="min-w-4 shrink-0 rounded-[5px] bg-(--accent) px-1 text-center text-[10px] font-medium tabular-nums text-(--accent-foreground) hover:bg-(--accent-hover)"
										>
											{conversation.unreadCount}
										</button>
									)}
								</span>
							</span>
						</button>
					);
				})
			)}
		</div>
	</aside>
);
