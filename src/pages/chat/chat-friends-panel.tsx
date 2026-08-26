import { FriendIdentity } from "@/components/friends/friend-identity";
import type { ChatFriend } from "@/types/chat";
import { useEffect, useRef } from "react";
import { FaComment, FaSignInAlt, FaTimes, FaUserPlus, FaUsers } from "react-icons/fa";
import { resolveFriendGameStatus } from "./chat-model";

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
	checking: string;
	reconnecting: string;
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

export const focusFriendsDrawer = (drawer: HTMLElement) => {
	drawer.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
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
			className="mt-1.5 grid grid-cols-3 gap-1"
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
						className="flex h-7 items-center justify-center gap-1 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[11px] font-medium text-(--text-secondary) transition-colors duration-150 hover:bg-(--surface-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-35"
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
		<header className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-(--line) px-3">
			<div className="flex items-center gap-2 text-[12px] font-medium text-(--text-primary)">
				<FaUsers className="text-(--text-muted)" aria-hidden="true" />
				{labels.title}
			</div>
			{showClose && (
				<button
					type="button"
					aria-label={labels.close}
					className="flex size-8 items-center justify-center rounded-sm text-(--ink-faint) hover:bg-white/8 hover:text-(--ink)"
					onClick={onClose}
				>
					<FaTimes aria-hidden="true" />
				</button>
			)}
		</header>
		<div className="p-2">
			<input
				type="search"
				value={search}
				aria-label={labels.search}
				placeholder={labels.search}
				className="h-7 w-full rounded-[6px] border border-(--border) bg-(--control) px-2.5 text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-muted) focus:border-(--accent) focus:shadow-[0_0_0_2px_var(--accent-soft)]"
				onChange={(event) => onSearchChange(event.currentTarget.value)}
			/>
		</div>
		<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
			{friends.length === 0 ? (
				<p className="px-3 py-8 text-center text-sm text-(--ink-faint)">{labels.empty}</p>
			) : (
				<ul>
					{friends.map((friend) => {
						const selected = selectedFriendPuuid === friend.puuid;
						const statusKey = resolveFriendGameStatus(friend);
						const syncing = statusKey === "checking" || statusKey === "reconnecting";
						const statusLabel =
							statusKey === "checking"
								? labels.checking
								: statusKey === "reconnecting"
									? labels.reconnecting
									: friend.statusMessage ||
										(friend.isOnline ? labels.online : labels.offline);
						return (
							<li key={friend.puuid} className="mb-0.5 p-1">
								<button
									type="button"
									data-friend-trigger={friend.puuid}
									aria-expanded={selected}
									aria-haspopup="menu"
									className={`flex min-h-11 w-full items-center gap-2.5 rounded-[6px] px-2 text-left transition-colors duration-150 ${selected ? "bg-[rgba(128,100,233,0.15)] text-(--accent-selected)" : "hover:bg-(--surface-hover)"}`}
									onClick={() => onFriendSelect(selected ? null : friend.puuid)}
								>
									<span
										className={`size-1.5 shrink-0 ${syncing ? "bg-(--signal-warn)" : friend.isOnline ? "bg-(--signal-pos)" : "bg-(--ink-faint)"}`}
										aria-label={statusLabel}
									/>
									<span className="min-w-0 flex-1">
										<FriendIdentity person={friend} showNote />
										<span className="block truncate text-[11px] text-(--ink-faint)">
											{statusLabel}
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
	const drawerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!props.drawerOpen) return;
		requestAnimationFrame(() => {
			if (drawerRef.current) focusFriendsDrawer(drawerRef.current);
		});
	}, [props.drawerOpen]);

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

	const runFriendAction = (
		action: (friend: ChatFriend) => void,
		friend: ChatFriend,
	) => {
		action(friend);
		closeFriendMenu();
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
					ref={drawerRef}
					data-friends-drawer="true"
					className="fixed inset-0 z-50 flex justify-end bg-black/70 xl:hidden"
					onKeyDownCapture={handleEscape}
				>
					<button type="button" aria-label={props.labels.close} className="min-w-10 flex-1" onClick={props.onClose} />
					<aside
						role="dialog"
						aria-modal="true"
						aria-label={props.labels.title}
						className="flex h-full w-[min(22rem,88vw)] flex-col border-l border-(--line) bg-(--panel) shadow-2xl"
					>
						<FriendsPanelContent
							{...props}
							onChat={(friend) => runFriendAction(props.onChat, friend)}
							onInvite={(friend) => runFriendAction(props.onInvite, friend)}
							onJoin={(friend) => runFriendAction(props.onJoin, friend)}
							showClose
						/>
					</aside>
				</div>
			)}
			<aside
				className="hidden h-full w-72 shrink-0 flex-col border-l border-(--border-subtle) bg-(--sidebar) xl:flex"
				onKeyDownCapture={handleEscape}
			>
				<FriendsPanelContent
					{...props}
					onChat={(friend) => runFriendAction(props.onChat, friend)}
					onInvite={(friend) => runFriendAction(props.onInvite, friend)}
					onJoin={(friend) => runFriendAction(props.onJoin, friend)}
					showClose={false}
				/>
			</aside>
		</>
	);
};
