import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { FaPaperPlane } from "react-icons/fa6";
import { matchComposerCommands, type ComposerCommandHint } from "./chat-model";

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
	hint,
	commands = [],
	inputRef,
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
	/** Keyboard help shown under the input, e.g. "Enter to send · . for commands". */
	hint?: string;
	commands?: ComposerCommandHint[];
	inputRef?: RefObject<HTMLTextAreaElement | null>;
	onDraftChange: (value: string) => void;
	onSend: () => void;
}) => {
	const ownRef = useRef<HTMLTextAreaElement>(null);
	const textareaRef = inputRef ?? ownRef;
	const wasSendingRef = useRef(sending);
	const [highlight, setHighlight] = useState(0);
	const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
	const suggestions = dismissedDraft === draft ? [] : matchComposerCommands(draft, commands);
	const active = Math.min(highlight, Math.max(suggestions.length - 1, 0));

	useEffect(() => {
		if (shouldRestoreComposerFocus(wasSendingRef.current, sending)) {
			textareaRef.current?.focus();
		}
		wasSendingRef.current = sending;
	}, [sending, textareaRef]);

	const pick = (command: ComposerCommandHint) => {
		onDraftChange(command.insert);
		setHighlight(0);
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (suggestions.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setHighlight((active + step + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				pick(suggestions[active]);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissedDraft(draft);
				return;
			}
		}
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		onSend();
	};

	return (
		<footer className="relative shrink-0 border-t border-(--line) bg-(--surface) px-3 pb-2 pt-2.5">
			{suggestions.length > 0 && (
				<ul
					role="listbox"
					aria-label="Commands"
					className="absolute inset-x-3 bottom-full mb-1 overflow-hidden rounded-[8px] border border-(--border) bg-(--panel) py-1 shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
				>
					{suggestions.map((command, index) => (
						<li key={command.insert} role="option" aria-selected={index === active}>
							<button
								type="button"
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setHighlight(index)}
								onClick={() => pick(command)}
								className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left ${
									index === active ? "bg-(--accent-soft)" : ""
								}`}
							>
								<span className="shrink-0 font-mono text-[12px] text-(--accent-selected)">{command.syntax}</span>
								<span className="min-w-0 flex-1 truncate text-[11px] text-(--text-muted)">
									{command.description}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{sendError && <p className="mb-1.5 text-[11px] text-(--signal-neg)">{sendError}</p>}
			<div className="flex items-center gap-1.5 rounded-[8px] border border-(--border) bg-(--control) py-1.5 pl-3 pr-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-(--accent) focus-within:shadow-[0_0_0_2px_var(--accent-soft)]">
				{/* Sizing is `!important`: index.css styles bare textareas outside any
				    layer, and unlayered CSS beats every Tailwind utility. */}
				<textarea
					ref={textareaRef}
					value={draft}
					onChange={(event) => {
						onDraftChange(event.target.value);
						setDismissedDraft(null);
					}}
					onKeyDown={onKeyDown}
					disabled={disabled || sending}
					rows={1}
					placeholder={disabled ? disabledReason : placeholder}
					aria-label={placeholder}
					aria-autocomplete="list"
					aria-expanded={suggestions.length > 0}
					className="field-sizing-content max-h-28! min-h-5! w-full resize-none bg-transparent px-0! py-1! text-[13px]! leading-5! text-(--text-primary) outline-none placeholder:text-(--text-muted) disabled:cursor-not-allowed disabled:opacity-50"
				/>
				<button
					type="button"
					onClick={onSend}
					disabled={disabled || sending || !draft.trim()}
					aria-label={sending ? sendingLabel : sendLabel}
					className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-(--accent-selected) outline-none transition-colors duration-150 hover:bg-(--accent-soft) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45"
				>
					<FaPaperPlane className="text-[13px]" />
				</button>
			</div>
			{disabled && disabledReason ? (
				<p className="mt-1 px-0.5 text-[10px] text-(--text-muted)">{disabledReason}</p>
			) : (
				hint && <p className="mt-1 px-0.5 text-[10px] text-(--text-muted)">{hint}</p>
			)}
		</footer>
	);
};
