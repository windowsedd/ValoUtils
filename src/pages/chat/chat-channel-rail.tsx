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
		className="flex w-[76px] shrink-0 flex-col gap-2 border-r border-white/8 bg-[#080a0f] px-2 py-4"
	>
		{channels.map(({ id, icon: Icon }) => {
			const active = selected === id;
			return (
				<button
					key={id}
					type="button"
					aria-pressed={active}
					data-channel-available={String(available[id])}
					onClick={() => onSelect(id)}
					className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold uppercase tracking-wide outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-300/80 ${
						active
							? "bg-white/9 text-white before:absolute before:left-[-8px] before:h-8 before:w-0.5 before:bg-[#ff4655]"
							: "text-gray-500 hover:bg-white/5 hover:text-gray-200"
					}`}
				>
					<Icon className="text-base" />
					<span>{labels[id]}</span>
					{!available[id] && id !== "friends" && (
						<span
							aria-label={`${labels[id]} unavailable`}
							className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-gray-700"
						/>
					)}
				</button>
			);
		})}
	</nav>
);
