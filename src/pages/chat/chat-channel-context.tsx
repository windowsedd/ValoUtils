import type { ChatChannel } from "@/types/chat";

export const ChatChannelContext = ({
	channel,
	title,
	available,
	availableLabel,
	unavailableLabel,
}: {
	channel: Exclude<ChatChannel, "friends">;
	title: string;
	available: boolean;
	availableLabel: string;
	unavailableLabel: string;
}) => (
	<aside
		data-channel-context={channel}
		data-channel-available={String(available)}
		className="flex w-[268px] shrink-0 flex-col border-r border-white/8 bg-[#0b0e14] p-3"
	>
		<div className="rounded-xl border border-white/8 bg-white/[0.035] p-4">
			<div className="flex items-center gap-2">
				<span
					className={`size-2 rounded-full ${available ? "bg-emerald-400" : "bg-gray-600"}`}
					aria-hidden="true"
				/>
				<h2 className="text-sm font-semibold text-white">{title}</h2>
			</div>
			<p className={`mt-2 text-xs ${available ? "text-emerald-300/75" : "text-gray-500"}`}>
				{available ? availableLabel : unavailableLabel}
			</p>
		</div>
	</aside>
);
