import { FriendIdentity } from "@/components/friends/friend-identity";
import type { ChatFriend } from "@/types/chat";
import { useEffect } from "react";
import { FaComment, FaSignInAlt, FaTimes, FaUserPlus, FaUsers } from "react-icons/fa";

type FriendsPanelLabels = {
	title: string;
	search: string;
	empty: string;
	chat: string;
	invite: string;
	join: string;
	close: string;
	online: string;
	offline: string;
};

type ChatFriendsPanelProps = {
	friends: ChatFriend[];
	search: string;
	drawerOpen: boolean;
	selectedFriendPuuid: string | null;
	pendingFriendPuuid: string | null;
	labels: FriendsPanelLabels;
	canChat: (friend: ChatFriend) => boolean;
	canInvite: (friend: ChatFriend) => boolean;
	canJoin: (friend: ChatFriend) => boolean;
	onSearchChange: (value: string) => void;
	onFriendSelect: (puuid: string | null) => void;
	onClose: () => void;
	onChat: (friend: ChatFriend) => void;
	onInvite: (friend: ChatFriend) => void;
	onJoin: (friend: ChatFriend) => void;
};

const findFriendElement = (attribute: "friendTrigger" | "friendMenu", puuid: string) => {
	const selector = attribute === "friendTrigger" ? "[data-friend-trigger]" : "[data-friend-menu]";
	return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
		(element) => element.dataset[attribute] === puuid && element.offsetParent !== null,
	);
};

const FriendActions = ({
	friend,
	pending,
	labels,
	canChat,
	canInvite,
	canJoin,
	onChat,
	onInvite,
	onJoin,
}: {
	friend: ChatFriend;
	pending: boolean;
	labels: FriendsPanelLabels;
	canChat: boolean;
	canInvite: boolean;
	canJoin: boolean;
	onChat: () => void;
	onInvite: () => void;
	onJoin: () => void;
}) => {
	const actions = [
		{ key: "chat", label: labels.chat, icon: FaComment, enabled: canChat, run: onChat },
		{ key: "invite", label: labels.invite, icon: FaUserPlus, enabled: canInvite, run: onInvite },
		{ key: "join", label: labels.join, icon: FaSignInAlt, enabled: canJoin, run: onJoin },
	] as const;

	return (
		<div
			role="menu"
			data-friend-menu={friend.puuid}
			className="mt-2 grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-black/30 p-1"
		>
			{actions.map((action) => {
				const Icon = action.icon;
				const disabled = pending || !action.enabled;
				return (
					<button
						key={action.key}
						type="button"
						role="menuitem"
						disabled={disabled}
						data-chat-available={action.key === "chat" ? String(action.enabled) : undefined}
						className="flex min-h-9 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-semibold text-gray-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
						onClick={action.run}
					>
						<Icon aria-hidden="true" />
						{action.label}
					</button>
				);
			})}
		</div>
	);
};

const FriendsPanelContent = ({
	friends,
	search,
	selectedFriendPuuid,
	pendingFriendPuuid,
	labels,
	canChat,
	canInvite,
	canJoin,
	onSearchChange,
	onFriendSelect,
	onClose,
	onChat,
	onInvite,
	onJoin,
	showClose,
}: ChatFriendsPanelProps & { showClose: boolean }) => (
	<>
		<header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
			<div className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.16em] text-gray-200">
				<FaUsers className="text-[#ff4655]" aria-hidden="true" />
				{labels.title}
			</div>
			{showClose && (
				<button
					type="button"
					aria-label={labels.close}
					className="flex size-9 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white"
					onClick={onClose}
				>
					<FaTimes aria-hidden="true" />
				</button>
			)}
		</header>
		<div className="p-3">
			<input
				type="search"
				value={search}
				aria-label={labels.search}
				placeholder={labels.search}
				className="h-9 w-full rounded-md border border-white/10 bg-black/30 px-3 text-sm text-white outline-none placeholder:text-gray-600 focus:border-[#ff4655]/70"
				onChange={(event) => onSearchChange(event.currentTarget.value)}
			/>
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
			{friends.length === 0 ? (
				<p className="px-3 py-8 text-center text-sm text-gray-500">{labels.empty}</p>
			) : (
				<ul className="space-y-1">
					{friends.map((friend) => {
						const selected = selectedFriendPuuid === friend.puuid;
						return (
							<li key={friend.puuid} className="rounded-lg bg-white/[0.025] p-1">
								<button
									type="button"
									data-friend-trigger={friend.puuid}
									aria-expanded={selected}
									aria-haspopup="menu"
									className="flex min-h-12 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-white/[0.06]"
									onClick={() => onFriendSelect(selected ? null : friend.puuid)}
								>
									<span
										className={`size-2 shrink-0 rounded-full ${friend.isOnline ? "bg-emerald-400" : "bg-gray-600"}`}
										aria-label={friend.isOnline ? labels.online : labels.offline}
									/>
									<span className="min-w-0 flex-1">
										<FriendIdentity person={friend} showNote />
										<span className="block truncate text-[11px] text-gray-500">
											{friend.statusMessage || (friend.isOnline ? labels.online : labels.offline)}
										</span>
									</span>
								</button>
								{selected && (
									<FriendActions
										friend={friend}
										pending={pendingFriendPuuid === friend.puuid}
										labels={labels}
										canChat={canChat(friend)}
										canInvite={canInvite(friend)}
										canJoin={canJoin(friend)}
										onChat={() => onChat(friend)}
										onInvite={() => onInvite(friend)}
										onJoin={() => onJoin(friend)}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	</>
);

export const ChatFriendsPanel = (props: ChatFriendsPanelProps) => {
	useEffect(() => {
		if (!props.selectedFriendPuuid) return;
		const menu = findFriendElement("friendMenu", props.selectedFriendPuuid);
		menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
	}, [props.selectedFriendPuuid]);

	const closeFriendMenu = () => {
		const puuid = props.selectedFriendPuuid;
		props.onFriendSelect(null);
		if (!puuid) return;
		requestAnimationFrame(() => findFriendElement("friendTrigger", puuid)?.focus());
	};

	const handleEscape = (event: React.KeyboardEvent) => {
		if (event.key !== "Escape") return;
		if (props.selectedFriendPuuid) {
			event.stopPropagation();
			closeFriendMenu();
			return;
		}
		if (props.drawerOpen) props.onClose();
	};

	return (
		<>
			{props.drawerOpen && (
				<div
					data-friends-drawer="true"
					className="fixed inset-0 z-50 flex justify-end bg-black/70 xl:hidden"
					onKeyDownCapture={handleEscape}
				>
					<button type="button" aria-label={props.labels.close} className="min-w-10 flex-1" onClick={props.onClose} />
					<aside className="flex h-full w-[min(22rem,88vw)] flex-col border-l border-white/10 bg-[#111214] shadow-2xl">
						<FriendsPanelContent {...props} showClose />
					</aside>
				</div>
			)}
			<aside
				className="hidden h-full w-72 shrink-0 flex-col border-l border-white/10 bg-[#111214] xl:flex"
				onKeyDownCapture={handleEscape}
			>
				<FriendsPanelContent {...props} showClose={false} />
			</aside>
		</>
	);
};
