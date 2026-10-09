import type { ChatChannel } from "@/types/chat";
import type { ChatRoomMember, ComposerCommandHint } from "./chat-model";
import { PlayerCardAvatar } from "./player-card-avatar";
import type { ReactNode } from "react";

export type ChatRoomMemberView = ChatRoomMember & {
	displayName: string;
	agentName: string;
	agentIcon: string | null;
};

type RoomLabels = {
	available: string;
	unavailable: string;
	members: string;
	membersEmpty: string;
	allies: string;
	enemies: string;
	you: string;
	noAgent: string;
	commands: string;
};

const MemberRow = ({ member, labels }: { member: ChatRoomMemberView; labels: RoomLabels }) => (
	<li className="flex items-center gap-2.5 rounded-[6px] px-2 py-1.5">
		{member.agentIcon ? (
			<img
				src={member.agentIcon}
				alt=""
				className="size-8 shrink-0 rounded-[7px] border border-(--border) bg-(--control) object-cover"
			/>
		) : (
			<PlayerCardAvatar
				cardId={member.cardId}
				name={member.displayName}
				className="size-8 border border-(--border)"
			/>
		)}
		<span className="min-w-0 flex-1">
			<span className="flex items-baseline gap-1.5">
				<span className="truncate text-[12px] font-medium text-(--text-primary)">{member.displayName}</span>
				{member.isSelf && (
					<span className="shrink-0 rounded-[4px] bg-(--accent-soft) px-1 text-[9px] font-semibold uppercase tracking-wide text-(--accent-selected)">
						{labels.you}
					</span>
				)}
			</span>
			<span className="block truncate text-[10px] uppercase tracking-wide text-(--text-muted)">
				{member.agentName || labels.noAgent}
			</span>
		</span>
	</li>
);

export const ChatChannelContext = ({
	channel,
	title,
	available,
	members,
	commands,
	labels,
	onPickCommand,
	history,
}: {
	channel: Exclude<ChatChannel, "friends">;
	title: string;
	available: boolean;
	members: ChatRoomMemberView[];
	commands: ComposerCommandHint[];
	labels: RoomLabels;
	onPickCommand: (command: ComposerCommandHint) => void;
	history?: ReactNode;
}) => {
	const allies = members.filter((member) => member.side === "ally");
	const enemies = members.filter((member) => member.side === "enemy");
	const split = channel === "all" && enemies.length > 0;

	return (
		<aside
			data-channel-context={channel}
			data-channel-available={String(available)}
			className="flex w-[268px] shrink-0 flex-col border-r border-(--line) bg-(--panel)"
		>
			<div className="p-2">
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
						{available ? labels.available : labels.unavailable}
					</p>
				</div>
			</div>

			{history}
			<section aria-label={labels.members} className="flex min-h-0 flex-1 flex-col">
				<h3 className="flex items-center justify-between px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
					<span>{labels.members}</span>
					<span className="tabular-nums">{members.length || ""}</span>
				</h3>
				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
					{members.length === 0 ? (
						<p className="px-2 py-4 text-[11px] leading-5 text-(--text-muted)">{labels.membersEmpty}</p>
					) : split ? (
						[
							{ label: labels.allies, list: allies },
							{ label: labels.enemies, list: enemies },
						].map(({ label, list }) => (
							<div key={label} className="mb-1">
								<p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-(--text-muted)">{label}</p>
								<ul>
									{list.map((member) => (
										<MemberRow key={member.puuid} member={member} labels={labels} />
									))}
								</ul>
							</div>
						))
					) : (
						<ul>
							{members.map((member) => (
								<MemberRow key={member.puuid} member={member} labels={labels} />
							))}
						</ul>
					)}
				</div>
			</section>

			<section aria-label={labels.commands} className="shrink-0 border-t border-(--line) px-2 pb-2 pt-2">
				<h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
					{labels.commands}
				</h3>
				<div className="flex flex-wrap gap-1 px-1">
					{commands.map((command) => (
						<button
							key={command.insert}
							type="button"
							title={`${command.syntax}\n${command.description}`}
							disabled={!available}
							onClick={() => onPickCommand(command)}
							className="h-6 rounded-[5px] border border-(--border) bg-(--control) px-1.5 font-mono text-[11px] text-(--text-secondary) outline-none transition-colors duration-150 hover:border-(--accent-border) hover:text-(--accent-selected) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] disabled:opacity-40"
						>
							{command.insert.trim()}
						</button>
					))}
				</div>
			</section>
		</aside>
	);
};
