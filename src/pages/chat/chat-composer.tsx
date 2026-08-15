import { useEffect, useRef, type KeyboardEvent } from "react";
import { FaPaperPlane } from "react-icons/fa6";

export const shouldRestoreComposerFocus = (wasSending: boolean, sending: boolean) =>
	wasSending && !sending;

export const ChatComposer = ({
	draft,
	disabled,
	disabledReason,
	sending,
	sendError,
	placeholder,
	sendLabel,
	sendingLabel,
	onDraftChange,
	onSend,
}: {
	draft: string;
	disabled: boolean;
	disabledReason: string;
	sending: boolean;
	sendError: string | null;
	placeholder: string;
	sendLabel: string;
	sendingLabel: string;
	onDraftChange: (value: string) => void;
	onSend: () => void;
}) => {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const wasSendingRef = useRef(sending);

	useEffect(() => {
		if (shouldRestoreComposerFocus(wasSendingRef.current, sending)) {
			textareaRef.current?.focus();
		}
		wasSendingRef.current = sending;
	}, [sending]);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		onSend();
	};

	return (
		<footer className="shrink-0 border-t border-(--line) bg-(--panel) px-3 py-2.5">
		{sendError && <p className="mb-2 text-xs text-(--signal-neg)">{sendError}</p>}
		<div className="flex items-end gap-2">
			<div className="min-w-0 flex-1">
				<textarea
					ref={textareaRef}
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={disabled || sending}
					rows={1}
					placeholder={disabled ? disabledReason : placeholder}
					aria-label={placeholder}
					className="max-h-32 min-h-9 w-full resize-none rounded-sm border border-(--line) bg-(--ground) px-2.5 py-2 text-sm text-(--ink) outline-none placeholder:text-(--ink-faint) focus:border-(--signal-focus)/50 disabled:cursor-not-allowed disabled:opacity-50"
				/>
				{disabled && disabledReason && (
					<p className="mt-1 px-0.5 text-[10px] text-(--ink-faint)">{disabledReason}</p>
				)}
			</div>
			{/* Sending a message isn't destructive, so it isn't red. Bone-white block,
			    the same "this is the live control" mark the nav rail uses. */}
			<button
				type="button"
				onClick={onSend}
				disabled={disabled || sending || !draft.trim()}
				aria-label={sending ? sendingLabel : sendLabel}
				className="flex h-9 min-w-9 items-center justify-center rounded-sm bg-(--ink) px-3 text-(--ground) outline-none transition-colors hover:bg-white focus-visible:ring-1 focus-visible:ring-(--signal-focus) disabled:cursor-not-allowed disabled:bg-(--line-strong) disabled:text-(--ink-faint)"
			>
				<FaPaperPlane />
			</button>
		</div>
	</footer>
);
};
