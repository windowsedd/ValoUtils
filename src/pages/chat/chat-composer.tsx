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
		<footer className="shrink-0 border-t border-white/8 bg-[#090b10] px-4 py-3">
		{sendError && <p className="mb-2 text-xs text-red-300">{sendError}</p>}
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
					className="max-h-32 min-h-10 w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-cyan-300/35 focus:ring-1 focus:ring-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-50"
				/>
				{disabled && disabledReason && (
					<p className="mt-1 px-1 text-[10px] text-gray-600">{disabledReason}</p>
				)}
			</div>
			<button
				type="button"
				onClick={onSend}
				disabled={disabled || sending || !draft.trim()}
				aria-label={sending ? sendingLabel : sendLabel}
				className="flex h-10 min-w-10 items-center justify-center rounded-xl bg-[#ff4655] px-3 text-white outline-none transition-colors hover:bg-[#ff5d69] focus-visible:ring-2 focus-visible:ring-cyan-300/80 disabled:cursor-not-allowed disabled:opacity-40"
			>
				<FaPaperPlane />
			</button>
		</div>
	</footer>
);
};
