import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type SelectMenuOption<T extends string> = {
	value: T;
	label: ReactNode;
	/** A muted second line under the label. */
	description?: ReactNode;
};

/** Radix Select reserves "" for "no selection", so an empty value travels as this. */
const EMPTY = "\u0000empty";
const toItem = (value: string) => (value === "" ? EMPTY : value);
const fromItem = (value: string) => (value === EMPTY ? "" : value);

/**
 * A themed replacement for a native `<select>`, built on the shadcn/ui Select.
 *
 * WebView2 draws a native select's open list with the operating system's own
 * light chrome, which no stylesheet reaches. The list here is the app's own,
 * portaled so a scrolling page or the rounded page sheet cannot clip it.
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
	const selected = options.find((option) => option.value === value) ?? options[0];
	return (
		<Select
			value={toItem(selected?.value ?? value)}
			onValueChange={(next) => {
				const picked = fromItem(next) as T;
				if (picked !== value) onChange(picked);
			}}
			disabled={disabled}
		>
			<SelectTrigger aria-label={ariaLabel} data-select-trigger="" className={className}>
				{/* Given explicitly so the label shows before the list has ever opened. */}
				<SelectValue>{selected?.label}</SelectValue>
			</SelectTrigger>
			<SelectContent data-select-menu="" aria-label={ariaLabel}>
				{options.map((option) => (
					<SelectItem key={option.value} value={toItem(option.value)} description={option.description}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
};
