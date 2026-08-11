import type { ChatChannel, ChatMessage } from "@/types/chat";
import { useEffect, useRef } from "react";
import { FaBug, FaLanguage, FaRotate, FaUserGroup } from "react-icons/fa6";
import {
	chatMessageKey,
	shouldResetThreadPosition,
	shouldStickToBottom,
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

const formatTime = (value: string | null) => {
	if (!value) return "";
	const numeric = Number(value);
	const date = new Date(Number.isFinite(numeric) ? numeric : value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const ChatThread = ({
	title,
	conversationId,
	channel,
	messages,
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
	conversationId: string | null;
	channel: ChatChannel;
	messages: ChatMessage[];
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
		<section className="flex min-h-0 flex-1 flex-col bg-[#07090d]">
		<header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-white/8 px-4">
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-sm font-semibold text-white">{title}</h1>
				<p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-400/70">
					{channel}
				</p>
			</div>
			<button
				type="button"
				onClick={(event) => onOpenFriends(event.currentTarget)}
				aria-label={labels.openFriends}
				className="flex h-10 w-10 items-center justify-center rounded-xl text-gray-400 outline-none hover:bg-white/6 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-300/80 xl:hidden"
			>
				<FaUserGroup />
			</button>
		</header>

		{historyError && (
			<div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-red-400/20 bg-red-950/20 px-3 py-2 text-xs text-red-200">
				<span className="min-w-0 flex-1 truncate">{historyError || labels.historyFailed}</span>
				<button
					type="button"
					onClick={onRetryHistory}
					className="min-h-8 rounded-lg px-3 font-semibold outline-none hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-cyan-300/80"
				>
					<FaRotate className="mr-1 inline" />
					{labels.retryHistory}
				</button>
			</div>
		)}

		{historyLoading && (
			<p className="px-4 pt-3 text-[11px] text-cyan-300/70">{labels.historyLoading}</p>
		)}

		<div
			ref={scrollRef}
			role="log"
			aria-live="polite"
			onScroll={() => {
				const node = scrollRef.current;
				if (node) stickRef.current = shouldStickToBottom(node, false);
			}}
			className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
		>
			{messages.length === 0 ? (
				<div className="flex h-full items-center justify-center text-sm text-gray-600">
					{labels.empty}
				</div>
			) : (
				<div className="space-y-3">
					{messages.map((message) => (
						<article
							key={`${message.conversationId}:${message.id}`}
							className={`flex ${message.isSelf ? "justify-end" : "justify-start"}`}
						>
							<div
								className={`max-w-[72%] rounded-2xl px-3.5 py-2.5 ${
									message.isSelf
										? "rounded-br-sm border border-cyan-400/20 bg-cyan-950/45"
										: "rounded-bl-sm border border-white/7 bg-white/5"
								}`}
							>
								<div className="mb-1 flex items-center gap-2 text-[10px]">
									<span className="max-w-48 truncate font-semibold text-gray-300">
										{message.senderName || message.sender}
									</span>
									<span className="text-gray-600">{formatTime(message.timestamp)}</span>
								</div>
								<p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-100">
									{message.body}
								</p>
								{translatedByMessageId[chatMessageKey(message)] && (
									<p className="mt-2 border-t border-cyan-300/10 pt-2 text-sm text-cyan-200">
										{translatedByMessageId[chatMessageKey(message)]}
									</p>
								)}
								{translationErrorByMessageId[chatMessageKey(message)] && (
									<p role="alert" className="mt-2 text-xs text-red-300">
										{translationErrorByMessageId[chatMessageKey(message)]}
									</p>
								)}
								<button
									type="button"
									onClick={() => onTranslate(message)}
									disabled={Boolean(translatingMessageId)}
									className="mt-2 min-h-8 rounded-lg px-2 text-[10px] text-gray-500 outline-none hover:bg-white/6 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-300/80 disabled:opacity-40"
								>
									<FaLanguage className="mr-1 inline" />
									{translatingMessageId === chatMessageKey(message)
										? labels.translating
										: labels.translate}
								</button>
							</div>
						</article>
					))}
				</div>
			)}
		</div>

		<details className="mx-4 mb-2 shrink-0 rounded-lg border border-white/7 bg-black/30 text-[10px] text-gray-500">
			<summary className="flex min-h-8 cursor-pointer items-center gap-2 px-3 outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80">
				<FaBug />
				{labels.developerPanel}
			</summary>
			<pre className="max-h-44 overflow-auto border-t border-white/7 p-3 font-mono text-gray-400">
				{JSON.stringify(debugData, null, 2)}
			</pre>
		</details>
	</section>
);
};
