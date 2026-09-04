import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown } from "react-icons/lu";
import {
	displayTranslationLanguage,
	getTranslationLanguages,
	type TranslationProvider,
} from "@/util/translation-languages";
import { autocompleteKeyAction } from "./bot-command-autocomplete";

type Props = {
	value: string;
	onChange: (value: string) => void;
	provider: TranslationProvider;
	placeholder?: string;
	inputClassName: string;
};

/**
 * Language picker for bot commands.
 *
 * A `<datalist>` would be less code, but its popup is drawn by the OS and takes
 * no CSS — in the app it lands as a pale system menu over a near-black panel.
 * This renders the list itself so it matches the surrounding chrome, and mirrors
 * the variables popover in the message editor so both autocompletes behave the
 * same way.
 *
 * The text field stays free-form on purpose: the backend also accepts plain
 * names ("french") and loose forms ("zh_tw"), so the list suggests rather than
 * constrains. Two tokens are not languages at all — "auto" defers to the
 * Settings target language, "none" skips translation entirely — so both are
 * pinned to the top rather than left for the user to remember.
 */
export const BotLanguageCombobox = ({
	value,
	onChange,
	provider,
	placeholder,
	inputClassName,
}: Props) => {
	const { t, i18n } = useTranslation();
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const wrapRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const options = useMemo(
		() => [
			// "auto" defers to the Settings target language; "none" sends the
			// message through untranslated. Two different things, so both are
			// offered explicitly rather than left to an empty field.
			{ code: "auto", label: t("dummyBot.customLanguageAuto") },
			{ code: "none", label: t("dummyBot.customLanguageNone") },
			...getTranslationLanguages(provider, "target").map((language) => ({
				code: language.code,
				label: displayTranslationLanguage(language, i18n.language),
			})),
		],
		[provider, i18n.language, t],
	);

	/*
	 * Underscores fold to hyphens before matching: the backend accepts "zh_tw"
	 * as happily as "zh-TW", and that loose form is the shipped default, so a
	 * literal compare would filter the list down to nothing on first open.
	 */
	const query = value.trim().toLowerCase().replace(/_/g, "-");
	const matches = useMemo(() => {
		if (!query || options.some((option) => option.code.toLowerCase() === query)) return options;
		const filtered = options.filter(
			(option) =>
				option.code.toLowerCase().includes(query) || option.label.toLowerCase().includes(query),
		);
		// Never collapse to an empty popover — an unrecognised value still gets
		// the full list to pick from rather than a box that looks broken.
		return filtered.length > 0 ? filtered : options;
	}, [options, query]);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	// Keep the highlighted row in view while arrowing through ~200 languages.
	useEffect(() => {
		if (!open) return;
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, open]);

	const choose = (code: string) => {
		onChange(code);
		setOpen(false);
	};

	return (
		<div ref={wrapRef} className="relative min-w-0">
			<div className="relative">
				<input
					value={value}
					onChange={(event) => {
						onChange(event.currentTarget.value);
						setActiveIndex(0);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					onKeyDown={(event) => {
						if (!open) {
							if (event.key === "ArrowDown") {
								setOpen(true);
								setActiveIndex(0);
								event.preventDefault();
							}
							return;
						}
						const action = autocompleteKeyAction(event.key, activeIndex, matches.length);
						if (!action.handled) return;
						event.preventDefault();
						setActiveIndex(action.activeIndex);
						if (action.dismiss) setOpen(false);
						if (action.commit && matches[action.activeIndex]) {
							choose(matches[action.activeIndex].code);
						}
					}}
					placeholder={placeholder}
					role="combobox"
					aria-expanded={open}
					aria-autocomplete="list"
					autoComplete="off"
					spellCheck={false}
					className={`${inputClassName} pr-7 font-mono`}
				/>
				<button
					type="button"
					tabIndex={-1}
					aria-label={t("dummyBot.customLanguageLabel")}
					onClick={() => setOpen((current) => !current)}
					className="absolute inset-y-0 right-0 grid w-7 place-items-center text-(--text-muted) transition-colors hover:text-(--text-primary)"
				>
					<LuChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
				</button>
			</div>

			{open && matches.length > 0 && (
				<div
					ref={listRef}
					role="listbox"
					className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-[6px] border border-(--border) bg-(--surface) p-1 shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
				>
					{matches.map((option, index) => (
						<button
							key={option.code}
							type="button"
							role="option"
							data-index={index}
							aria-selected={index === activeIndex}
							onMouseDown={(event) => event.preventDefault()}
							onMouseEnter={() => setActiveIndex(index)}
							onClick={() => choose(option.code)}
							className={`flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors ${
								index === activeIndex ? "bg-(--surface-hover)" : ""
							}`}
						>
							<code className="shrink-0 font-mono text-[11px] text-(--accent-selected)">
								{option.code}
							</code>
							<span className="min-w-0 flex-1 truncate text-[11px] text-(--text-secondary)">
								{option.label}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
};
