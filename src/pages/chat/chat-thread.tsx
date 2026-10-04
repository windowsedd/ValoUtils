import type { ChatMessage, ChatRound } from "@/types/chat";
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { SystemLine } from "./chat-controller-state";
import { FaRotate, FaUserGroup } from "react-icons/fa6";
import { PlayerCardAvatar } from "./player-card-avatar";
import {
	chatDayDividers,
	chatMessageKey,
	chatRoundDividers,
	formatClock,
	shouldResetThreadPosition,
	shouldStickToBottom,
	startsMessageGroup,
} from "./chat-model";

type ThreadLabels = {
	openFriends: string;
	historyLoading: string;
	historyFailed: string;
	retryHistory: string;
	translate: string;
	translating: string;
	empty: string;
	running: string;
	formatDay: (time: number) => string;
	/** Appended to your own message times, e.g. "Sent". */
	sent?: string;
};

/** Block-letter art from `.ascii`. */
export const isBlockArt = (body: string) => /[█░▀▄]{6}/.test(body);

const HATCH = "repeating-linear-gradient(135deg, rgba(255,255,255,0.16) 0 1px, transparent 1px 3px)";
const INK = "var(--text-primary)";
const cellBackground = (cell: string) =>
	cell === "█"
		? INK
		: cell === "▀"
			? `linear-gradient(${INK} 0 50%, transparent 50%), ${HATCH}`
			: cell === "▄"
				? `linear-gradient(transparent 0 50%, ${INK} 50%), ${HATCH}`
				: cell === "░"
					? HATCH
					: "transparent";

/**
 * Draws `.ascii` art cell by cell. No font gives █ and ░ the same advance, so
 * text rendering drifts row by row; fixed cells keep the panel square, with ░
 * hatched the way VALORANT draws it.
 */
const BlockArt = ({ body }: { body: string }) => (
	<div role="img" aria-label={body} className="flex flex-col">
		{body.split("\n").map((row, rowIndex) => (
			<div key={rowIndex} className="flex">
				{Array.from(row).map((cell, cellIndex) => (
					<span key={cellIndex} className="h-3.5 w-1.75 shrink-0" style={{ background: cellBackground(cell) }} />
				))}
			</div>
		))}
	</div>
);

/** Outlined 文A mark, matching the design preview. */
const TranslateIcon = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4.5">
		<path d="M3 5h12M9 3v2M5 5c1 5 4 8 9 10M13 5c-1 5-4 8-9 10M13 21l4-10 4 10M14.5 18h5" />
	</svg>
);

export type ChatThreadSender = {
	name: string;
	/** Agent name, "not selected" text, or "" when the sender is not in the live roster. */
	agentLabel: string;
	agentIcon: string | null;
	/** Shown until an agent is picked (party lobby). */
	cardId?: string | null;
	/** Fit the icon instead of cropping it (logos rather than portraits). */
	iconContain?: boolean;
};

const SenderAvatar = ({
	name,
	icon,
	cardId,
	contain = false,
}: {
	name: string;
	icon: string | null;
	cardId?: string | null;
	contain?: boolean;
}) =>
	icon ? (
		<img
			src={icon}
			alt=""
			className={`size-9 shrink-0 rounded-[9px] border border-(--border) bg-(--control) ${contain ? "object-contain p-1.5" : "object-cover"}`}
		/>
	) : (
		<PlayerCardAvatar cardId={cardId} name={name} className="size-9 border border-(--border)" />
	);

export const ChatThread = ({
	title,
	subtitle,
	conversationId,
	messages,
	systemLines,
	historyLoading,
	historyError,
	translatedByMessageId,
	translationErrorByMessageId,
	translatingMessageId,
	labels,
	onRetryHistory,
	onTranslate,
	onOpenFriends,
	describeSender,
	formatRound,
	notice,
	icon,
}: {
	title: string;
	subtitle: string;
	conversationId: string | null;
	messages: ChatMessage[];
	systemLines: SystemLine[];
	historyLoading: boolean;
	historyError: string | null;
	translatedByMessageId: Record<string, string>;
	translationErrorByMessageId: Record<string, string>;
	translatingMessageId: string | null;
	labels: ThreadLabels;
	onRetryHistory: () => void;
	onTranslate: (message: ChatMessage) => void;
	onOpenFriends: (trigger: HTMLButtonElement) => void;
	/** Party/team/all: portrait, Riot ID and agent for each sender. */
	describeSender?: (message: ChatMessage) => ChatThreadSender;
	/** Party/team/all: label for the round divider ("Round 5 · 2 : 1"). */
	formatRound?: (round: ChatRound) => string;
	/** Centred status line at the top of the thread, e.g. "Joined party chat". */
	notice?: string;
	/** Header badge; the title's initial is used without one. */
	icon?: ReactNode;
}) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const previousConversationRef = useRef(conversationId);
	const lastMessage = messages[messages.length - 1];
	const dayDividers = useMemo(() => chatDayDividers(messages), [messages]);
	const roundDividers = useMemo(
		() => (formatRound ? chatRoundDividers(messages) : []),
		[formatRound, messages],
	);

	useEffect(() => {
		if (stickRef.current || lastMessage?.isSelf) {
			scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
		}
	}, [lastMessage?.id, lastMessage?.isSelf]);

	useEffect(() => {
		if (shouldResetThreadPosition(previousConversationRef.current, conversationId)) {
			stickRef.current = true;
			scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
		}
		previousConversationRef.current = conversationId;
	}, [conversationId]);

	return (
		<section className="flex min-h-0 flex-1 flex-col bg-(--surface)">
			<header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-(--line) px-3">
				{icon ?? (
					<span className="grid size-7.5 shrink-0 place-items-center rounded-[6px] bg-(--control) text-[11px] font-medium text-(--text-secondary)">
						{(title.trim()[0] ?? "?").toUpperCase()}
					</span>
				)}
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-[13px] font-semibold text-(--text-primary)">{title}</h1>
					<p className="truncate text-[11px] text-(--text-muted)">{subtitle}</p>
				</div>
				<button
					type="button"
					onClick={(event) => onOpenFriends(event.currentTarget)}
					aria-label={labels.openFriends}
					className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-(--text-muted) outline-none transition-colors duration-150 hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] xl:hidden"
				>
					<FaUserGroup />
				</button>
			</header>

			{historyError && (
				<div className="flex shrink-0 items-center gap-3 border-b border-(--signal-neg)/25 bg-(--signal-neg)/8 px-3 py-2 text-[11px] text-(--signal-neg)">
					<span className="min-w-0 flex-1 truncate">{historyError || labels.historyFailed}</span>
					<button
						type="button"
						onClick={onRetryHistory}
						className="h-7 shrink-0 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[11px] font-medium text-(--text-secondary) outline-none hover:bg-(--surface-hover) hover:text-(--text-primary)"
					>
						<FaRotate className="mr-1 inline" />
						{labels.retryHistory}
					</button>
				</div>
			)}

			{historyLoading && (
				<p className="shrink-0 px-3 pt-2 text-[11px] text-(--text-muted)">{labels.historyLoading}</p>
			)}

			<div
				ref={scrollRef}
				role="log"
				aria-live="polite"
				onScroll={() => {
					const node = scrollRef.current;
					if (node) stickRef.current = shouldStickToBottom(node, false);
				}}
				className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4"
			>
				{messages.length === 0 && systemLines.length === 0 ? (
					<div className="flex h-full items-center justify-center text-[12px] text-(--text-muted)">
						{labels.empty}
					</div>
				) : (
					messages.map((message, index) => {
						const key = chatMessageKey(message);
						const roundDivider = roundDividers[index];
						const dayDivider = dayDividers[index];
						const opensGroup =
							Boolean(roundDivider || dayDivider) || startsMessageGroup(messages[index - 1], message);
						const translated = translatedByMessageId[key];
						const translationError = translationErrorByMessageId[key];
						const sender = message.isSelf ? null : (describeSender?.(message) ?? null);
						const name = sender?.name || message.senderName || message.sender;

						return (
							<Fragment key={`${message.conversationId}:${message.id}`}>
							{dayDivider != null && (
								<div
									role="separator"
									className={`flex items-center gap-3 text-[10px] font-medium text-(--text-muted) before:h-px before:flex-1 before:bg-(--line) after:h-px after:flex-1 after:bg-(--line) ${index === 0 ? "mb-4" : "mb-4 mt-6"}`}
								>
									<span>{labels.formatDay(dayDivider)}</span>
								</div>
							)}
							{index === 0 && notice && (
								<p className="mb-6 text-center text-[11px] text-(--text-muted)">{notice}</p>
							)}
							{roundDivider && formatRound && (
								<div
									role="separator"
									className={`flex items-center gap-3 text-[10px] font-medium uppercase tracking-wide text-(--text-muted) before:h-px before:flex-1 before:bg-(--line) after:h-px after:flex-1 after:bg-(--line) ${index === 0 || dayDivider != null ? "mb-4" : "mb-4 mt-6"}`}
								>
									<span className="tabular-nums">{formatRound(roundDivider)}</span>
								</div>
							)}
							<article
								className={`flex gap-2.5 ${message.isSelf ? "justify-end" : "justify-start"} ${opensGroup ? (index === 0 || roundDivider || dayDivider != null ? "" : "mt-5") : "mt-1.5"}`}
							>
								{sender &&
									(opensGroup ? (
										<SenderAvatar name={name} icon={sender.agentIcon} cardId={sender.cardId} contain={sender.iconContain} />
									) : (
										<span aria-hidden="true" className="w-9 shrink-0" />
									))}
								<div className={`flex min-w-0 max-w-[78%] flex-col ${message.isSelf ? "items-end" : "items-start"}`}>
									{opensGroup && !message.isSelf && (
										<p className="mb-1 flex max-w-full items-baseline gap-1.5">
											<span className="truncate text-[12px] font-semibold text-(--text-primary)">{name}</span>
											{sender?.agentLabel && (
												<span className="shrink-0 text-[10px] uppercase tracking-wide text-(--text-muted)">
													{sender.agentLabel}
												</span>
											)}
										</p>
									)}
									<div className={`flex min-w-0 max-w-full items-end gap-1.5 ${message.isSelf ? "flex-row-reverse" : ""}`}>
										<div
											className={`min-w-0 border px-3.5 py-2.5 ${
												message.isSelf
													? "rounded-[11px_4px_11px_11px] border-(--accent-border) bg-(--accent-soft)"
													: "rounded-[4px_11px_11px_11px] border-(--border) bg-(--control)"
											}`}
										>
											{isBlockArt(message.body) ? (
												<BlockArt body={message.body} />
											) : (
												<p className="whitespace-pre-wrap wrap-anywhere text-[13px] leading-5 text-(--text-primary)">
													{message.body}
												</p>
											)}
										</div>
										{!isBlockArt(message.body) && (
										<button
											type="button"
											onClick={() => onTranslate(message)}
											disabled={Boolean(translatingMessageId)}
											aria-label={labels.translate}
											aria-pressed={Boolean(translated)}
											title={labels.translate}
											className={`mb-px flex size-6.5 shrink-0 items-center justify-center rounded-[6px] outline-none transition-colors duration-150 hover:bg-(--accent-soft) hover:text-(--accent-selected) focus-visible:bg-(--accent-soft) focus-visible:text-(--accent-selected) disabled:opacity-40 ${
												translated ? "bg-(--accent-soft) text-(--accent-selected)" : "text-(--text-muted)"
											}`}
										>
											<TranslateIcon />
											<span className="sr-only">
												{translatingMessageId === key ? labels.translating : labels.translate}
											</span>
										</button>
										)}
									</div>
									{translated && (
										<p className="mt-2 max-w-95 wrap-anywhere border-l-2 border-(--accent-border) pl-2.5 text-[12px] leading-5 text-(--text-secondary)">
											{translated}
										</p>
									)}
									{translationError && (
										<p role="alert" className="mt-1 text-[11px] text-(--signal-neg)">
											{translationError}
										</p>
									)}
									<p className="mt-1.5 text-[10px] tabular-nums text-(--text-muted)">
										{formatClock(message.timestamp)}
										{message.isSelf && labels.sent ? ` · ${labels.sent}` : ""}
									</p>
								</div>
							</article>
							</Fragment>
						);
					})
				)}

				{systemLines.map((line) => (
					<article key={line.id} className="mt-3 flex justify-center px-6">
						<div
							className={`max-w-[85%] rounded-[8px] border px-3 py-2 ${
								line.failed
									? "border-(--signal-neg)/30 bg-(--signal-neg)/6"
									: "border-dashed border-(--border) bg-(--background)"
							}`}
						>
							<p className="font-mono text-[10px] text-(--accent-selected)">{line.command}</p>
							{line.pending ? (
								<p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-(--text-muted)">
									<span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-(--accent)" />
									{labels.running}
								</p>
							) : (
								<p
									className={`mt-0.5 whitespace-pre-wrap wrap-anywhere text-[12px] leading-5 ${
										line.failed ? "text-(--signal-neg)" : "text-(--text-secondary)"
									}`}
								>
									{line.body}
								</p>
							)}
						</div>
					</article>
				))}
			</div>
		</section>
	);
};
