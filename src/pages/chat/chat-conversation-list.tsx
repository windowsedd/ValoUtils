import type { FriendConversation, FriendGameStatus } from "./chat-model";
import { FaMagnifyingGlass } from "react-icons/fa6";

export type FriendStatusLabels = Record<FriendGameStatus, string>;

const formatTime = (timestamp: number) => {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

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
	<aside className="flex w-[268px] shrink-0 flex-col border-r border-white/8 bg-[#0b0e14]">
		<div className="p-3">
			<label className="flex min-h-10 items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 text-gray-500 focus-within:border-cyan-300/35 focus-within:ring-1 focus-within:ring-cyan-300/20">
				<FaMagnifyingGlass aria-hidden="true" />
				<span className="sr-only">{searchLabel}</span>
				<input
					type="search"
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder={searchLabel}
					className="min-w-0 flex-1 bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600"
				/>
			</label>
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
			{conversations.length === 0 ? (
				<p className="px-3 py-8 text-center text-xs text-gray-600">{emptyLabel}</p>
			) : (
				conversations.map((conversation) => {
					const selected = selectedCid === conversation.cid;
					return (
						<button
							key={conversation.cid}
							type="button"
							aria-current={selected || undefined}
							onClick={() => onSelect(conversation.cid)}
							className={`mb-1 flex min-h-16 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-300/80 ${
								selected ? "bg-white/9" : "hover:bg-white/5"
							}`}
						>
							<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-950 to-slate-800 text-xs font-bold text-cyan-200">
								{conversation.title.slice(0, 2).toUpperCase()}
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-100">
										{conversation.title}
									</span>
									<span className="shrink-0 text-[10px] tabular-nums text-gray-600">
										{formatTime(conversation.latestTime)}
									</span>
								</span>
								<span className="mt-1 flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-xs text-gray-500">
										{statusLabels[conversation.statusKey]}
									</span>
									{conversation.unreadCount > 0 && (
										<span
											data-unread-count={conversation.unreadCount}
											className="min-w-5 shrink-0 rounded-full bg-[#ff4655] px-1.5 py-0.5 text-center text-[10px] font-bold text-white"
										>
											{conversation.unreadCount}
										</span>
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
