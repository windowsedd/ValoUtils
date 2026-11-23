import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui ContextMenu (Radix): opens on right click, the context-menu key or
 * Shift+F10, moves with the arrow keys and type-ahead, closes on Escape and
 * returns focus. Styled like Popover.
 */
function ContextMenu(props: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
	return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger(props: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
	return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Content
				data-slot="context-menu-content"
				className={cn(
					"z-[60] min-w-48 rounded-[10px] border border-(--border) bg-(--surface) p-1 text-(--text-primary) shadow-(--overlay-shadow) outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
					className,
				)}
				{...props}
			/>
		</ContextMenuPrimitive.Portal>
	);
}

function ContextMenuItem({
	className,
	destructive = false,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }) {
	return (
		<ContextMenuPrimitive.Item
			data-slot="context-menu-item"
			className={cn(
				"flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-[12px] text-(--text-secondary) outline-none data-[highlighted]:bg-(--surface-hover) data-[highlighted]:text-(--text-primary) data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0",
				destructive && "data-[highlighted]:text-(--signal-neg)",
				className,
			)}
			{...props}
		/>
	);
}

function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
	return (
		<ContextMenuPrimitive.Label
			data-slot="context-menu-label"
			className={cn("truncate px-2 pb-1 pt-1.5 text-[11px] font-medium text-(--text-muted)", className)}
			{...props}
		/>
	);
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
	return (
		<ContextMenuPrimitive.Separator
			data-slot="context-menu-separator"
			className={cn("my-1 h-px bg-(--line)", className)}
			{...props}
		/>
	);
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger };
