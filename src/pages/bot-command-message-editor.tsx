import { useAiConfigured } from "@/util/ai";
import { invoke } from "@tauri-apps/api/core";
import { reportIpcError } from "@/util/ipc";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	autocompleteKeyAction,
	filterTemplateVariables,
	findActiveTemplateRange,
	insertTemplateVariable,
	type BotTemplateGroup,
} from "./bot-command-autocomplete";

type Props = { value: string; onChange: (value: string) => void; placeholder: string };
const GROUPS: BotTemplateGroup[] = ["enemy", "ally", "me", "match"];

export const BotCommandMessageEditor = ({ value, onChange, placeholder }: Props) => {
	const { t } = useTranslation();
	const aiConfigured = useAiConfigured();
	const inputRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [caret, setCaret] = useState(value.length);
	const [activeIndex, setActiveIndex] = useState(0);
	const range = findActiveTemplateRange(value, caret);
	const matches = useMemo(
		() => filterTemplateVariables(range?.query ?? "", (item) => t(item.descriptionKey)),
		[range?.query, t],
	);

	const choose = (id: string) => {
		const next = insertTemplateVariable(value, caret, id);
		onChange(next.value);
		setCaret(next.caret);
		setOpen(false);
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(next.caret, next.caret);
		});
	};

	return <div className="relative col-span-2 min-w-0">
		<div className="flex min-w-0 gap-1">
			<input
				ref={inputRef}
				value={value}
				onChange={(event) => {
					const nextCaret = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
					onChange(event.currentTarget.value);
					setCaret(nextCaret);
					setActiveIndex(0);
					setOpen(findActiveTemplateRange(event.currentTarget.value, nextCaret) !== null);
				}}
				onClick={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
				onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
				onKeyDown={(event) => {
					if (!open) return;
					const action = autocompleteKeyAction(event.key, activeIndex, matches.length);
					if (!action.handled) return;
					event.preventDefault();
					setActiveIndex(action.activeIndex);
					if (action.dismiss) setOpen(false);
					if (action.commit) choose(matches[action.activeIndex].id);
				}}
				placeholder={placeholder}
				aria-autocomplete="list"
				aria-expanded={open}
				aria-controls="bot-template-options"
				className="min-w-0 flex-1 rounded-sm border border-(--line) bg-(--panel-raised) px-2 py-1.5 text-xs text-(--ink)"
			/>
			<button
				type="button"
				onClick={() => {
					setCaret(inputRef.current?.selectionStart ?? value.length);
					setActiveIndex(0);
					setOpen(true);
				}}
				className="shrink-0 rounded-sm border border-(--line) bg-(--panel-raised) px-2 text-[10px] text-(--ink-dim) hover:text-(--ink)"
			>
				{t("dummyBot.variablesButton")}
			</button>
            <button type="button" title={t("ai.blockHelp")} className="shrink-0 rounded-sm border border-(--line) px-2 text-[10px]" onClick={() => {
                const position = inputRef.current?.selectionStart ?? value.length;
                const end = inputRef.current?.selectionEnd ?? position;
                onChange(value.slice(0, position) + "{{ai: }}" + value.slice(end));
                setCaret(position + 6); setOpen(false);
                invoke("analytics_track", { args: ["ai:bot_block_insert"] }).catch(reportIpcError);
                requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(position + 6, position + 6); });
            }}>{t("ai.block")}</button>
        </div>
        {/\{\{ai:/i.test(value) && <p className="mt-1 text-[10px] text-(--text-muted)">{t("ai.blockHelp")}{!aiConfigured && <> {t("ai.configureHint")}</>}</p>}
        {open && <div id="bot-template-options" role="listbox" aria-label={t("dummyBot.variablesLabel")} className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-sm border border-(--line-strong) bg-(--panel) p-1 shadow-xl">
			{GROUPS.map((group) => {
				const items = matches.filter((item) => item.group === group);
				if (items.length === 0) return null;
				return <div key={group}>
					<p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-(--ink-faint)">{t(`dummyBot.variableGroup.${group}`)}</p>
					{items.map((item) => {
						const index = matches.indexOf(item);
						return <button key={item.id} type="button" role="option" aria-selected={index === activeIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item.id)} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-white/8 aria-selected:bg-white/8">
							<code className="text-[11px] text-(--ink)">{`{{${item.id}}}`}</code>
							<span className="min-w-0 flex-1 truncate text-[10px] text-(--ink-dim)">{t(item.descriptionKey)}</span>
							<span className="text-[10px] text-(--ink-faint)">{item.example}</span>
						</button>;
					})}
				</div>;
			})}
		</div>}
	</div>;
};
