import type { ChatMessage } from "@/types/chat";
import { useEffect, useRef } from "react";
import type { SystemLine } from "./chat-controller-state";
import { FaBug, FaLanguage, FaRotate, FaUserGroup } from "react-icons/fa6";
import {
	chatMessageKey,
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
	developerPanel: string;
	empty: string;
};

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
	debugData,
	labels,
	onRetryHistory,
	onTranslate,
	onOpenFriends,
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
	debugData: unknown;
	labels: ThreadLabels;
	onRetryHistory: () => void;
	onTranslate: (message: ChatMessage) => void;
	onOpenFriends: (trigger: HTMLButtonElement) => void;
}) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const previousConversationRef = useRef(conversationId);
	const lastMessage = messages[messages.length - 1];

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
		<section className="flex min-h-0 flex-1 flex-col bg-(--ground)">
			<header className="flex min-h-13 shrink-0 items-baseline gap-2.5 border-b border-(--line) px-4 py-3">
				<h1 className="truncate text-sm font-semibold text-(--ink)">{title}</h1>
				<span className="truncate text-xs text-(--ink-faint)">{subtitle}</span>
				<span aria-hidden="true" className="readout-leader" />
				<button
					type="button"
					onClick={(event) => onOpenFriends(event.currentTarget)}
					aria-label={labels.openFriends}
					className="flex size-8 shrink-0 items-center justify-center self-center rounded-sm text-(--ink-faint) outline-none hover:bg-white/6 hover:text-(--ink) focus-visible:ring-1 focus-visible:ring-(--signal-focus) xl:hidden"
				>
					<FaUserGroup />
				</button>
			</header>

			{historyError && (
				<div className="flex shrink-0 items-center gap-3 border-b border-(--signal-neg)/25 bg-(--signal-neg)/8 px-4 py-2 text-xs text-(--signal-neg)">
					<span className="min-w-0 flex-1 truncate">{historyError || labels.historyFailed}</span>
					<button
						type="button"
						onClick={onRetryHistory}
						className="min-h-7 shrink-0 rounded-sm px-2 font-semibold text-(--ink-dim) outline-none hover:bg-white/8 hover:text-(--ink) focus-visible:ring-1 focus-visible:ring-(--signal-focus)"
					>
						<FaRotate className="mr-1 inline" />
						{labels.retryHistory}
					</button>
				</div>
			)}

			{historyLoading && (
				<p className="shrink-0 px-4 pt-2 text-[11px] text-(--ink-faint)">{labels.historyLoading}</p>
			)}

			{/*
			 * A transcript, not a messenger. This is a relay log off an XMPP socket —
			 * who spoke and when is the information, so it reads as a timestamped
			 * record: mono clock gutter, sender header per burst, body at full width.
			 * Bubbles would spend 30% of a narrow window on silhouette.
			 */}
			<div
				ref={scrollRef}
				role="log"
				aria-live="polite"
				onScroll={() => {
					const node = scrollRef.current;
					if (node) stickRef.current = shouldStickToBottom(node, false);
				}}
				className="min-h-0 flex-1 overflow-y-auto py-2"
			>
				{messages.length === 0 && systemLines.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-(--ink-faint)">
						{labels.empty}
					</div>
				) : (
					messages.map((message, index) => {
						const key = chatMessageKey(message);
						const opensGroup = startsMessageGroup(messages[index - 1], message);
						const translated = translatedByMessageId[key];
						const translationError = translationErrorByMessageId[key];

						return (
							<article
								key={`${message.conversationId}:${message.id}`}
								className={`group relative px-4 hover:bg-white/2.5 ${opensGroup ? "mt-2 first:mt-0" : ""}`}
							>
								{/* Self is marked in the gutter, not by swapping sides or hues. */}
								{message.isSelf && (
									<span aria-hidden="true" className="absolute left-0 top-0 h-full w-0.5 bg-(--ink-faint)" />
								)}

								{/* The sender hangs above its burst, indented to the body column so
								    the clock gutter stays an unbroken ruler down the left edge. */}
								{opensGroup && (
									<p
										className={`truncate pl-13 text-xs font-semibold leading-5 ${message.isSelf ? "text-(--ink)" : "text-(--ink-dim)"}`}
									>
										{message.senderName || message.sender}
									</p>
								)}

								<div className="flex items-start gap-3">
									<span className="w-10 shrink-0 select-none whitespace-nowrap text-right text-[10px] tabular-nums leading-5 text-(--ink-faint)">
										{formatClock(message.timestamp)}
									</span>
									<div className="min-w-0 flex-1">
										<p className="whitespace-pre-wrap wrap-break-word text-sm leading-5 text-(--ink)">
											{message.body}
										</p>
										{translated && (
											<p className="mt-1 border-l border-(--line-strong) pl-2 text-sm leading-5 text-(--ink-dim)">
												{translated}
											</p>
										)}
										{translationError && (
											<p role="alert" className="mt-1 text-xs text-(--signal-neg)">
												{translationError}
											</p>
										)}
									</div>
									{/* One action, revealed on hover, instead of a button parked
									    under every line in the log. */}
									<button
										type="button"
										onClick={() => onTranslate(message)}
										disabled={Boolean(translatingMessageId)}
										aria-label={labels.translate}
										className="shrink-0 self-start rounded-sm px-1.5 py-0.5 text-[10px] text-(--ink-faint) opacity-0 outline-none transition-opacity hover:bg-white/8 hover:text-(--ink) focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-(--signal-focus) group-hover:opacity-100 disabled:opacity-40"
									>
										<FaLanguage className="mr-1 inline" />
										{translatingMessageId === key ? labels.translating : labels.translate}
									</button>
								</div>
							</article>
						);
					})
				)}

				{/* Command results, pinned under the log. Local only - none of
				    this was sent to the room, so it is deliberately unattributed
				    and visually quieter than a real message. */}
				{systemLines.map((line) => (
					<article key={line.id} className="px-4 pt-2">
						<p className="font-mono text-[11px] text-(--ink-faint)">{line.command}</p>
						<p
							className={`whitespace-pre-wrap text-xs ${
								line.failed ? "text-(--signal-neg)" : "text-(--ink-dim)"
							}`}
						>
							{line.body}
						</p>
					</article>
				))}
			</div>

			<details className="shrink-0 border-t border-(--line) bg-(--panel) text-[10px] text-(--ink-faint)">
				<summary className="flex min-h-8 cursor-pointer items-center gap-2 px-4 outline-none focus-visible:ring-1 focus-visible:ring-(--signal-focus)">
					<FaBug />
					{labels.developerPanel}
				</summary>
				<pre className="max-h-44 overflow-auto border-t border-(--line) p-3 font-mono text-(--ink-dim)">
					{JSON.stringify(debugData, null, 2)}
				</pre>
			</details>
		</section>
	);
};
