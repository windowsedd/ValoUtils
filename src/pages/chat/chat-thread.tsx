import type { ChatMessage } from "@/types/chat";
import { useEffect, useRef } from "react";
import type { SystemLine } from "./chat-controller-state";
import { FaLanguage, FaRotate, FaUserGroup } from "react-icons/fa6";
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
		<section className="flex min-h-0 flex-1 flex-col bg-(--surface)">
			<header className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-(--line) px-3">
				<span className="grid h-7 w-7 shrink-0 place-items-center rounded-[6px] bg-(--control) text-[11px] font-medium text-(--text-secondary)">
					{(title.trim()[0] ?? "?").toUpperCase()}
				</span>
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-[13px] font-medium text-(--text-primary)">{title}</h1>
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
				className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
			>
				{messages.length === 0 && systemLines.length === 0 ? (
					<div className="flex h-full items-center justify-center text-[12px] text-(--text-muted)">
						{labels.empty}
					</div>
				) : (
					messages.map((message, index) => {
						const key = chatMessageKey(message);
						const opensGroup = startsMessageGroup(messages[index - 1], message);
						const translated = translatedByMessageId[key];
						const translationError = translationErrorByMessageId[key];
						const name = message.senderName || message.sender;

						return (
							<article
								key={`${message.conversationId}:${message.id}`}
								className={`group flex ${message.isSelf ? "justify-end" : "justify-start"} ${opensGroup ? (index === 0 ? "" : "mt-3") : "mt-1"}`}
							>
								<div className={`flex max-w-[78%] items-end gap-1.5 ${message.isSelf ? "flex-row-reverse" : ""}`}>
									<div
										className={`rounded-[8px] px-2.5 py-1.5 ${
											message.isSelf
												? "bg-(--accent-soft) border border-(--accent-border)"
												: "bg-(--control) border border-(--border)"
										}`}
									>
										{opensGroup && !message.isSelf && (
											<p className="mb-0.5 truncate text-[10px] font-medium text-(--accent-selected)">
												{name}
											</p>
										)}
										<p className="whitespace-pre-wrap wrap-break-word text-[12px] leading-5 text-(--text-primary)">
											{message.body}
										</p>
										{translated && (
											<p className="mt-1 border-l border-(--accent-border) pl-2 text-[12px] leading-5 text-(--text-secondary)">
												{translated}
											</p>
										)}
										{translationError && (
											<p role="alert" className="mt-1 text-[11px] text-(--signal-neg)">
												{translationError}
											</p>
										)}
										<p className="mt-1 text-right text-[10px] tabular-nums text-(--text-muted)">
											{formatClock(message.timestamp)}
										</p>
									</div>
									<button
										type="button"
										onClick={() => onTranslate(message)}
										disabled={Boolean(translatingMessageId)}
										aria-label={labels.translate}
										className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-(--text-muted) opacity-0 outline-none transition-[opacity,background-color,color] duration-150 hover:bg-(--surface-hover) hover:text-(--accent-selected) focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
									>
										<FaLanguage />
										<span className="sr-only">
											{translatingMessageId === key ? labels.translating : labels.translate}
										</span>
									</button>
								</div>
							</article>
						);
					})
				)}

				{systemLines.map((line) => (
					<article key={line.id} className="mt-2 flex justify-center px-6">
						<div className="max-w-full rounded-[6px] border border-(--border) bg-(--background) px-2.5 py-1.5">
							<p className="font-mono text-[10px] text-(--text-muted)">{line.command}</p>
							<p
								className={`whitespace-pre-wrap text-[11px] ${
									line.failed ? "text-(--signal-neg)" : "text-(--text-secondary)"
								}`}
							>
								{line.body}
							</p>
						</div>
					</article>
				))}
			</div>
		</section>
	);
};
