import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown } from "react-icons/lu";

export type SelectMenuOption<T extends string> = {
	value: T;
	label: ReactNode;
	/** A muted second line under the label. */
	description?: ReactNode;
};

/** `top` when the menu opens below the trigger, `bottom` when it opens above. */
type Placement = { top?: number; bottom?: number; left: number; width: number; maxHeight: number };

const GAP = 4;
const MAX_HEIGHT = 280;
const EDGE = 8;

/** Opens below the trigger, or above it when the space below is the smaller side. */
export const placeSelectMenu = (
	anchor: Pick<DOMRect, "top" | "bottom" | "left" | "width">,
	viewportHeight: number,
): Placement => {
	const below = viewportHeight - anchor.bottom - GAP - EDGE;
	const above = anchor.top - GAP - EDGE;
	const flip = below < Math.min(MAX_HEIGHT, 160) && above > below;
	const room = flip ? above : below;
	return {
		...(flip ? { bottom: viewportHeight - anchor.top + GAP } : { top: anchor.bottom + GAP }),
		left: anchor.left,
		width: anchor.width,
		maxHeight: Math.max(96, Math.min(MAX_HEIGHT, room)),
	};
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A themed replacement for a native `<select>`.
 *
 * WebView2 draws a native select's open list with the operating system's own
 * light chrome, which no stylesheet reaches. This keeps the trigger looking
 * like the app's other fields and draws the list itself, in a portal so a
 * scrolling page or the rounded page sheet cannot clip it.
 */
export const SelectMenu = <T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	className = "",
	disabled = false,
}: {
	value: T;
	options: SelectMenuOption<T>[];
	onChange: (value: T) => void;
	ariaLabel?: string;
	/** Classes for the trigger; it should match the surrounding fields. */
	className?: string;
	disabled?: boolean;
}) => {
	const listId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [placement, setPlacement] = useState<Placement | null>(null);
	const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
	const selected = options[selectedIndex];

	useIsomorphicLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const bounds = triggerRef.current?.getBoundingClientRect();
			if (bounds) setPlacement(placeSelectMenu(bounds, window.innerHeight));
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	useEffect(() => {
		if (open && placement) listRef.current?.focus({ preventScroll: true });
	}, [open, placement]);

	useEffect(() => {
		if (!open) return;
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, active]);

	const show = () => {
		if (disabled) return;
		setActive(selectedIndex);
		setOpen(true);
	};

	const dismiss = () => {
		setOpen(false);
		triggerRef.current?.focus();
	};

	const choose = (index: number) => {
		const option = options[index];
		if (option && option.value !== value) onChange(option.value);
		dismiss();
	};

	const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
			event.preventDefault();
			show();
		}
	};

	const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const last = options.length - 1;
		const moves: Record<string, () => number> = {
			ArrowDown: () => Math.min(last, active + 1),
			ArrowUp: () => Math.max(0, active - 1),
			Home: () => 0,
			End: () => last,
			PageDown: () => Math.min(last, active + 5),
			PageUp: () => Math.max(0, active - 5),
		};
		if (moves[event.key]) {
			event.preventDefault();
			setActive(moves[event.key]());
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			choose(active);
		} else if (event.key === "Escape") {
			event.preventDefault();
			dismiss();
		} else if (event.key === "Tab") {
			setOpen(false);
		}
	};

	const list =
		open && placement ? (
			<div
				ref={listRef}
				id={listId}
				role="listbox"
				tabIndex={-1}
				aria-label={ariaLabel}
				aria-activedescendant={`${listId}-${active}`}
				onKeyDown={onListKey}
				data-select-menu=""
				className="fixed z-[70] overflow-y-auto rounded-[10px] border border-(--border) bg-(--surface) p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)] outline-none animate-fade-in"
				style={{
					top: placement.top,
					bottom: placement.bottom,
					left: placement.left,
					minWidth: placement.width,
					maxHeight: placement.maxHeight,
				}}
			>
				{options.map((option, index) => {
					const isSelected = option.value === value;
					return (
						<div
							key={option.value}
							id={`${listId}-${index}`}
							role="option"
							aria-selected={isSelected}
							data-index={index}
							onMouseEnter={() => setActive(index)}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => choose(index)}
							className={`select-menu-option flex cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-[12px] ${
								index === active ? "bg-(--surface-hover)" : ""
							} ${isSelected ? "text-(--accent-selected)" : "text-(--text-primary)"}`}
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate">{option.label}</span>
								{option.description && (
									<span className="block truncate text-[11px] text-(--text-muted)">{option.description}</span>
								)}
							</span>
							<LuCheck aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${isSelected ? "" : "invisible"}`} />
						</div>
					);
				})}
			</div>
		) : null;

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-label={ariaLabel}
				onClick={() => (open ? setOpen(false) : show())}
				onKeyDown={onTriggerKey}
				data-select-trigger=""
				className={`press-flat flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
					open ? "border-(--accent) shadow-[0_0_0_2px_var(--accent-soft)]" : ""
				} ${className}`}
			>
				<span className="min-w-0 truncate">{selected?.label}</span>
				<LuChevronDown
					aria-hidden="true"
					className={`h-3.5 w-3.5 shrink-0 text-(--text-muted) transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{list && (typeof document === "undefined" ? list : createPortal(list, document.body))}
		</>
	);
};
