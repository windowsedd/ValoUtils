import { useAiConfigured } from "@/util/ai";
import { invoke } from "@tauri-apps/api/core";
import { reportIpcError } from "@/util/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { LuBraces, LuMaximize2, LuSparkles, LuX } from "react-icons/lu";
import {
	autocompleteKeyAction,
	filterTemplateVariables,
	findActiveTemplateRange,
	insertTemplateVariable,
	type BotTemplateGroup,
} from "./bot-command-autocomplete";

type Props = { value: string; onChange: (value: string) => void; placeholder: string };
const GROUPS: BotTemplateGroup[] = ["enemy", "ally", "me", "match"];
/** Riot's chat limit. Variables expand later, so this counts the template as typed. */
export const CHAT_MESSAGE_LIMIT = 350;
/** Chat messages are one line; pasted newlines become spaces. */
export const singleLine = (value: string) => value.replace(/\r?\n/g, " ");

const toolButton =
	"flex shrink-0 items-center gap-1.5 rounded-[6px] border border-(--border) bg-(--control) px-2.5 text-[11px] font-medium text-(--text-secondary) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary) focus-visible:outline-none focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]";

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * The message input with its variable autocomplete and AI block insert. One
 * field drives both the inline row and the full-screen editor, so the two never
 * disagree about how a variable is completed.
 */
const MessageField = ({
	value,
	onChange,
	placeholder,
	multiline = false,
	autoFocus = false,
	onExpand,
}: Props & { multiline?: boolean; autoFocus?: boolean; onExpand?: () => void }) => {
	const { t } = useTranslation();
	const inputRef = useRef<FieldElement>(null);
	const [open, setOpen] = useState(false);
	const [caret, setCaret] = useState(value.length);
	const [activeIndex, setActiveIndex] = useState(0);
	const listId = multiline ? "bot-template-options-expanded" : "bot-template-options";
	const range = findActiveTemplateRange(value, caret);
	const matches = useMemo(
		() => filterTemplateVariables(range?.query ?? "", (item) => t(item.descriptionKey)),
		[range?.query, t],
	);

	useEffect(() => {
		if (!autoFocus) return;
		const field = inputRef.current;
		field?.focus();
		field?.setSelectionRange(field.value.length, field.value.length);
	}, [autoFocus]);

	const focusAt = (position: number) =>
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(position, position);
		});

	const choose = (id: string) => {
		const next = insertTemplateVariable(value, caret, id);
		onChange(next.value);
		setCaret(next.caret);
		setOpen(false);
		focusAt(next.caret);
	};

	const fieldProps = {
		value,
		placeholder,
		"aria-autocomplete": "list" as const,
		"aria-expanded": open,
		"aria-controls": listId,
		onChange: (event: React.ChangeEvent<FieldElement>) => {
			const next = singleLine(event.currentTarget.value);
			const nextCaret = event.currentTarget.selectionStart ?? next.length;
			onChange(next);
			setCaret(nextCaret);
			setActiveIndex(0);
			setOpen(findActiveTemplateRange(next, nextCaret) !== null);
		},
		onClick: (event: React.MouseEvent<FieldElement>) => setCaret(event.currentTarget.selectionStart ?? value.length),
		onKeyUp: (event: React.KeyboardEvent<FieldElement>) => setCaret(event.currentTarget.selectionStart ?? value.length),
		onKeyDown: (event: React.KeyboardEvent<FieldElement>) => {
			if (open) {
				const action = autocompleteKeyAction(event.key, activeIndex, matches.length);
				if (action.handled) {
					event.preventDefault();
					setActiveIndex(action.activeIndex);
					if (action.dismiss) setOpen(false);
					if (action.commit) choose(matches[action.activeIndex].id);
					return;
				}
			}
			// A chat message has no line breaks.
			if (multiline && event.key === "Enter") event.preventDefault();
		},
	};

	const insertAiBlock = () => {
		const position = inputRef.current?.selectionStart ?? value.length;
		const end = inputRef.current?.selectionEnd ?? position;
		onChange(value.slice(0, position) + "{{ai: }}" + value.slice(end));
		setCaret(position + 6);
		setOpen(false);
		invoke("analytics_track", { args: ["ai:bot_block_insert"] }).catch(reportIpcError);
		focusAt(position + 6);
	};

	const tools = (
		<>
			<button
				type="button"
				onClick={() => {
					setCaret(inputRef.current?.selectionStart ?? value.length);
					setActiveIndex(0);
					setOpen(true);
				}}
				className={toolButton}
			>
				<LuBraces className="h-3 w-3" aria-hidden="true" />
				{t("dummyBot.variablesButton")}
			</button>
			<button type="button" title={t("ai.blockHelp")} className={toolButton} onClick={insertAiBlock}>
				<LuSparkles className="h-3 w-3 text-(--accent-selected)" aria-hidden="true" />
				{t("ai.block")}
			</button>
		</>
	);

	return (
		<div className="relative min-w-0">
			{multiline ? (
				<>
					<textarea
						ref={inputRef as React.RefObject<HTMLTextAreaElement>}
						{...fieldProps}
						data-message-editor="expanded"
						className="block min-h-[40vh] w-full resize-none rounded-[10px] border border-(--border) bg-(--control) px-3.5 py-3 font-mono text-[13px] leading-relaxed text-(--text-primary)"
					/>
					<div className="mt-2 flex gap-1.5">{tools}</div>
				</>
			) : (
				<div className="flex min-w-0 gap-1.5">
					<input
						ref={inputRef as React.RefObject<HTMLInputElement>}
						{...fieldProps}
						className="min-w-0 flex-1 rounded-[6px] border border-(--border) bg-(--control) px-2 py-1.5 text-[12px] text-(--text-primary)"
					/>
					{tools}
					{onExpand && (
						<button
							type="button"
							onClick={onExpand}
							aria-label={t("dummyBot.messageExpand")}
							title={t("dummyBot.messageExpand")}
							data-message-expand=""
							className={`${toolButton} press-tile w-8 justify-center px-0`}
						>
							<LuMaximize2 className="h-3.5 w-3.5" aria-hidden="true" />
						</button>
					)}
				</div>
			)}
			{open && (
				<div
					id={listId}
					role="listbox"
					aria-label={t("dummyBot.variablesLabel")}
					className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-[10px] border border-(--border) bg-(--surface) p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
				>
					{GROUPS.map((group) => {
						const items = matches.filter((item) => item.group === group);
						if (items.length === 0) return null;
						return (
							<div key={group}>
								<p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-(--text-muted)">
									{t(`dummyBot.variableGroup.${group}`)}
								</p>
								{items.map((item) => {
									const index = matches.indexOf(item);
									return (
										<button
											key={item.id}
											type="button"
											role="option"
											aria-selected={index === activeIndex}
											onMouseDown={(event) => event.preventDefault()}
											onClick={() => choose(item.id)}
											className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left hover:bg-(--surface-hover)"
										>
											<code className="text-[11px] text-(--text-primary)">{`{{${item.id}}}`}</code>
											<span className="min-w-0 flex-1 truncate text-[10px] text-(--text-secondary)">{t(item.descriptionKey)}</span>
											<span className="text-[10px] text-(--text-muted)">{item.example}</span>
										</button>
									);
								})}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

/** A full-window editor for long messages, closed with Done, Esc or the backdrop. */
const ExpandedMessageEditor = ({ value, onChange, placeholder, onClose }: Props & { onClose: () => void }) => {
	const { t } = useTranslation();
	const over = value.length > CHAT_MESSAGE_LIMIT;

	useEffect(() => {
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) onClose();
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [onClose]);

	return createPortal(
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-(--backdrop) p-6 animate-fade-in"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("dummyBot.customMessageLabel")}
				className="flex max-h-full w-full max-w-4xl flex-col rounded-[16px] border border-(--border) bg-(--surface) shadow-[0_24px_64px_rgba(0,0,0,0.5)]"
			>
				<header className="flex items-center justify-between gap-3 border-b border-(--line) px-5 py-3">
					<h2 className="text-[14px] font-semibold text-(--text-primary)">{t("dummyBot.customMessageLabel")}</h2>
					<button
						type="button"
						onClick={onClose}
						aria-label={t("common.close")}
						className="grid h-8 w-8 place-items-center rounded-[8px] text-(--text-muted) transition-colors hover:bg-(--surface-hover) hover:text-(--text-primary)"
					>
						<LuX className="h-4 w-4" />
					</button>
				</header>
				<div className="min-h-0 overflow-y-auto px-5 py-4">
					<MessageField value={value} onChange={onChange} placeholder={placeholder} multiline autoFocus />
				</div>
				<footer className="flex items-center justify-between gap-3 border-t border-(--line) px-5 py-3">
					<span className={`text-[11px] tabular-nums ${over ? "text-(--signal-warn)" : "text-(--text-muted)"}`} data-message-length="">
						{t("dummyBot.messageLength", { count: value.length, limit: CHAT_MESSAGE_LIMIT })}
					</span>
					<button
						type="button"
						onClick={onClose}
						className="h-8 rounded-[8px] bg-(--accent) px-4 text-[12px] font-medium text-(--accent-foreground) transition-colors hover:bg-(--accent-hover)"
					>
						{t("dummyBot.messageDone")}
					</button>
				</footer>
			</div>
		</div>,
		document.body,
	);
};

export const BotCommandMessageEditor = ({ value, onChange, placeholder }: Props) => {
	const { t } = useTranslation();
	const aiConfigured = useAiConfigured();
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="col-span-2 min-w-0">
			<MessageField value={value} onChange={onChange} placeholder={placeholder} onExpand={() => setExpanded(true)} />
			{/\{\{ai:/i.test(value) && (
				<p className="mt-1 text-[10px] text-(--text-muted)">
					{t("ai.blockHelp")}
					{!aiConfigured && <> {t("ai.configureHint")}</>}
				</p>
			)}
			{expanded && (
				<ExpandedMessageEditor
					value={value}
					onChange={onChange}
					placeholder={placeholder}
					onClose={() => setExpanded(false)}
				/>
			)}
		</div>
	);
};
