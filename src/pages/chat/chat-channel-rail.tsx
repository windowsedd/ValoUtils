import type { ChatChannel } from "@/types/chat";
import type { ComponentType } from "react";
import { FaComments } from "react-icons/fa6";

type ChannelAvailability = Record<ChatChannel, boolean>;
type ChannelLabels = Record<ChatChannel, string>;

const channels: Array<{ id: ChatChannel; icon: ComponentType<{ className?: string }> }> = [
	{ id: "friends", icon: FaComments },
];

/** Chat tab only offers friends DMs. Party/team/all stay on the in-game bot. */
export const visibleChatChannels: ChatChannel[] = ["friends"];

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
					className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-[6px] border border-transparent px-1 text-[10px] font-medium uppercase tracking-[0.06em] outline-none transition-[color,background-color,border-color] duration-150 focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] ${
						active
							? "bg-[rgba(128,100,233,0.15)] border-[rgba(128,100,233,0.2)] text-(--accent-selected)"
							: "text-(--text-muted) hover:bg-(--surface-hover) hover:text-(--text-primary)"
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
