import type { ChatChannel } from "@/types/chat";
import type { ComponentType } from "react";
import { FaComments, FaGlobe, FaShieldHalved, FaUserGroup } from "react-icons/fa6";

type ChannelAvailability = Record<ChatChannel, boolean>;
type ChannelLabels = Record<ChatChannel, string>;

const channels: Array<{ id: ChatChannel; icon: ComponentType<{ className?: string }> }> = [
	{ id: "friends", icon: FaComments },
	{ id: "party", icon: FaUserGroup },
	{ id: "team", icon: FaShieldHalved },
	{ id: "all", icon: FaGlobe },
];

/**
 * Channels the UI offers. Party, team, and all-chat only exist while you're in a
 * party or a live match; unavailable rooms stay on the rail at reduced opacity
 * so the switcher is always there when a room appears.
 */
export const visibleChatChannels: ChatChannel[] = ["friends", "party", "team", "all"];

const visibleChannels = channels.filter((channel) =>
	visibleChatChannels.includes(channel.id),
);

export const ChatChannelRail = ({
	selected,
	available,
	labels,
	onSelect,
}: {
	selected: ChatChannel;
	available: ChannelAvailability;
	labels: ChannelLabels;
	onSelect: (channel: ChatChannel) => void;
}) => (
	<nav
		aria-label="Chat channels"
		className="flex w-19 shrink-0 flex-col gap-px border-r border-(--line) bg-(--panel) px-1.5 py-2"
	>
		{visibleChannels.map(({ id, icon: Icon }) => {
			const active = selected === id;
			// Subordinate to the app rail: this one marks itself with a tick and a
			// raised fill, so the two rails don't both shout the inverted block.
			return (
				<button
					key={id}
					type="button"
					aria-pressed={active}
					data-channel-available={String(available[id])}
					onClick={() => onSelect(id)}
					className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-sm px-1 text-[10px] font-semibold uppercase tracking-[0.06em] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-(--signal-focus) ${
						active
							? "bg-(--panel-raised) text-(--ink) before:absolute before:left-0 before:h-6 before:w-0.5 before:bg-(--ink)"
							: "text-(--ink-faint) hover:bg-white/4 hover:text-(--ink-dim)"
					} ${!available[id] && id !== "friends" ? "opacity-45" : ""}`}
				>
					<Icon className="text-base" />
					<span>{labels[id]}</span>
					{!available[id] && id !== "friends" && (
						<span className="sr-only">{`${labels[id]} unavailable`}</span>
					)}
				</button>
			);
		})}
	</nav>
);
