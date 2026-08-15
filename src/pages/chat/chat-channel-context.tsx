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
		className="flex w-[268px] shrink-0 flex-col border-r border-(--line) bg-(--panel) p-2"
	>
		<div className="panel-raised p-3">
			<div className="readout">
				<h2 className="text-sm font-semibold text-(--ink)">{title}</h2>
				<span aria-hidden="true" className="readout-leader" />
				<span
					aria-hidden="true"
					className={`size-1.5 shrink-0 self-center ${available ? "bg-(--signal-pos)" : "bg-(--ink-faint)"}`}
				/>
			</div>
			{/* The reason wraps as prose — an unavailable room explains itself, and a
			    sentence squeezed into a right-hand readout slot just truncates. */}
			<p className={`mt-2 text-xs leading-5 ${available ? "text-(--signal-pos)" : "text-(--ink-faint)"}`}>
				{available ? availableLabel : unavailableLabel}
			</p>
		</div>
	</aside>
);
