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
		<footer className="shrink-0 border-t border-(--line) bg-(--surface) px-3 py-2">
			{sendError && <p className="mb-1.5 text-[11px] text-(--signal-neg)">{sendError}</p>}
			<div className="flex items-end gap-1.5 rounded-[8px] border border-(--border) bg-(--control) px-2 py-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-(--accent) focus-within:shadow-[0_0_0_2px_var(--accent-soft)]">
				<textarea
					ref={textareaRef}
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={disabled || sending}
					rows={1}
					placeholder={disabled ? disabledReason : placeholder}
					aria-label={placeholder}
					className="max-h-28 min-h-7 w-full resize-none bg-transparent px-1 py-0.5 text-[12px] leading-5 text-(--text-primary) outline-none placeholder:text-(--text-muted) disabled:cursor-not-allowed disabled:opacity-50"
				/>
				<button
					type="button"
					onClick={onSend}
					disabled={disabled || sending || !draft.trim()}
					aria-label={sending ? sendingLabel : sendLabel}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-(--accent) text-(--accent-foreground) outline-none transition-[background-color] duration-150 hover:bg-(--accent-hover) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] disabled:cursor-not-allowed disabled:bg-(--border) disabled:text-(--text-muted)"
				>
					<FaPaperPlane className="text-[11px]" />
				</button>
			</div>
			{disabled && disabledReason && (
				<p className="mt-1 px-0.5 text-[10px] text-(--text-muted)">{disabledReason}</p>
			)}
		</footer>
	);
};
