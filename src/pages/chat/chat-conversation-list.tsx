import type { FriendConversation, FriendGameStatus } from "./chat-model";
import { formatClock } from "./chat-model";
import { FaMagnifyingGlass } from "react-icons/fa6";

export type FriendStatusLabels = Record<FriendGameStatus, string>;

export const ChatConversationList = ({
	conversations,
	selectedCid,
	statusLabels,
	search,
	searchLabel,
	emptyLabel,
	onSearchChange,
	onSelect,
}: {
	conversations: FriendConversation[];
	selectedCid: string | null;
	statusLabels: FriendStatusLabels;
	search: string;
	searchLabel: string;
	emptyLabel: string;
	onSearchChange: (value: string) => void;
	onSelect: (cid: string) => void;
}) => (
	<aside className="flex w-[268px] shrink-0 flex-col border-r border-(--line) bg-(--panel)">
		<div className="p-2">
			<label className="flex min-h-9 items-center gap-2 rounded-sm border border-(--line) bg-(--ground) px-2.5 text-(--ink-faint) focus-within:border-(--signal-focus)/50">
				<FaMagnifyingGlass aria-hidden="true" className="text-xs" />
				<span className="sr-only">{searchLabel}</span>
				<input
					type="search"
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder={searchLabel}
					className="min-w-0 flex-1 bg-transparent text-sm text-(--ink) outline-none placeholder:text-(--ink-faint)"
				/>
			</label>
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
			{conversations.length === 0 ? (
				<p className="px-3 py-8 text-center text-xs text-(--ink-faint)">{emptyLabel}</p>
			) : (
				conversations.map((conversation) => {
					const selected = selectedCid === conversation.cid;
					return (
						<button
							key={conversation.cid}
							type="button"
							aria-current={selected || undefined}
							onClick={() => onSelect(conversation.cid)}
							className={`relative flex w-full flex-col gap-0.5 rounded-sm px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-(--signal-focus) ${
								selected
									? "bg-(--panel-raised) before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-(--ink)"
									: "hover:bg-white/4"
							}`}
						>
							<span className="flex items-baseline gap-2">
								<span className="min-w-0 flex-1 truncate text-sm font-semibold text-(--ink)">
									{conversation.title}
								</span>
								<span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-(--ink-faint)">
									{formatClock(conversation.latestTime)}
								</span>
							</span>
							<span className="flex items-baseline gap-2">
								<span className="min-w-0 flex-1 truncate text-xs text-(--ink-faint)">
									{statusLabels[conversation.statusKey]}
								</span>
								{/* Unread is pending attention, not danger — the warn signal, and a
								    block rather than a pill so it lines up with the timestamp above. */}
								{conversation.unreadCount > 0 && (
									<span
										data-unread-count={conversation.unreadCount}
										className="min-w-4 shrink-0 rounded-xs bg-(--signal-warn) px-1 text-center text-[10px] font-bold tabular-nums text-(--ground)"
									>
										{conversation.unreadCount}
									</span>
								)}
							</span>
						</button>
					);
				})
			)}
		</div>
	</aside>
);
