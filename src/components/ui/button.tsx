import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { LuLoaderCircle } from "react-icons/lu";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Button, restyled to ValoUtils' compact dark chrome. Colours come
 * from the app's own tokens in index.css (shadcn's theme names would clash:
 * `--accent` here is the purple brand colour, not a hover surface).
 */
const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border font-medium outline-none transition-[background-color,border-color,color,box-shadow,scale] duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "border-(--border) bg-(--control) text-(--text-primary) hover:bg-[#38383d] active:bg-[#2a2a2e]",
				accent: "border-transparent bg-(--accent) text-(--accent-foreground) hover:bg-(--accent-hover)",
				secondary:
					"border-(--border) bg-(--surface) text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)",
				destructive: "border-transparent bg-(--signal-neg) text-[#f8ecee] hover:bg-(--valo-dark-red)",
				success: "border-transparent bg-(--signal-pos) text-(--background) hover:brightness-110",
				outline:
					"border-(--border) bg-transparent text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)",
				ghost: "border-transparent bg-transparent text-(--text-secondary) hover:bg-(--surface-hover) hover:text-(--text-primary)",
				link: "h-auto border-transparent bg-transparent px-0 text-(--accent-selected) underline-offset-4 hover:underline",
			},
			size: {
				default: "h-7 px-2.5 text-[12px] [&_svg]:size-3.5",
				sm: "h-6 px-2 text-[11px] [&_svg]:size-3",
				lg: "h-8 px-3 text-[12px] [&_svg]:size-4",
				icon: "size-7 text-[12px] [&_svg]:size-3.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

type ButtonProps = React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
		/** Shows a spinner and blocks clicks until the action settles. */
		pending?: boolean;
	};

function Button({ className, variant, size, asChild = false, pending = false, disabled, children, ...props }: ButtonProps) {
	const Comp = asChild ? Slot.Root : "button";
	return (
		<Comp
			data-slot="button"
			data-pending={pending || undefined}
			aria-busy={pending || undefined}
			className={cn(buttonVariants({ variant, size, className }))}
			disabled={disabled || pending}
			{...props}
		>
			{pending && !asChild && <LuLoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
			{children}
		</Comp>
	);
}

export { Button, buttonVariants };
export type { ButtonProps };
