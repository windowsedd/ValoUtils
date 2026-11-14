import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { LuCheck, LuChevronDown, LuChevronUp } from "react-icons/lu";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Select in the app's field style. The list is drawn by the app,
 * not the OS (WebView2 paints a native <select> list in light system chrome),
 * and Radix brings keyboard navigation, type-ahead and collision handling.
 */
function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
	return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>) {
	return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
	return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			className={cn(
				"press-flat flex h-7 w-full items-center justify-between gap-2 rounded-[6px] border border-(--border) bg-(--control) px-2 text-left text-[12px] text-(--text-primary) outline-none transition-[border-color,box-shadow] duration-150 hover:border-[#3c3c42] focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-(--text-muted) data-[state=open]:border-(--accent) data-[state=open]:shadow-[0_0_0_2px_var(--accent-soft)] [&>span]:min-w-0 [&>span]:truncate",
				className,
			)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon asChild>
				<LuChevronDown
					aria-hidden="true"
					className="size-3.5 shrink-0 text-(--text-muted) transition-transform duration-150 motion-reduce:transition-none [[data-state=open]>&]:rotate-180"
				/>
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	position = "popper",
	...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				data-slot="select-content"
				position={position}
				sideOffset={4}
				className={cn(
					"relative z-[70] max-h-[min(280px,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width) overflow-hidden rounded-[10px] border border-(--border) bg-(--surface) text-(--text-primary) shadow-[0_16px_40px_rgba(0,0,0,0.45)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
					className,
				)}
				{...props}
			>
				<SelectPrimitive.ScrollUpButton className="flex h-5 items-center justify-center text-(--text-muted)">
					<LuChevronUp className="size-3.5" />
				</SelectPrimitive.ScrollUpButton>
				<SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
				<SelectPrimitive.ScrollDownButton className="flex h-5 items-center justify-center text-(--text-muted)">
					<LuChevronDown className="size-3.5" />
				</SelectPrimitive.ScrollDownButton>
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	);
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
	return (
		<SelectPrimitive.Label
			data-slot="select-label"
			className={cn("px-2.5 py-1 text-[10px] font-medium uppercase tracking-widest text-(--text-muted)", className)}
			{...props}
		/>
	);
}

function SelectItem({
	className,
	children,
	description,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Item> & {
	/** A muted second line under the label, left out of the trigger. */
	description?: React.ReactNode;
}) {
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				"select-menu-option relative flex cursor-pointer select-none items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-[12px] text-(--text-primary) outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-(--surface-hover) data-[state=checked]:text-(--accent-selected)",
				className,
			)}
			{...props}
		>
			<span className="min-w-0 flex-1">
				<span className="block truncate">
					<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
				</span>
				{description && <span className="block truncate text-[11px] text-(--text-muted)">{description}</span>}
			</span>
			<span className="grid size-3.5 shrink-0 place-items-center">
				<SelectPrimitive.ItemIndicator>
					<LuCheck aria-hidden="true" className="size-3.5" />
				</SelectPrimitive.ItemIndicator>
			</span>
		</SelectPrimitive.Item>
	);
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
	return <SelectPrimitive.Separator data-slot="select-separator" className={cn("my-1 h-px bg-(--line)", className)} {...props} />;
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
