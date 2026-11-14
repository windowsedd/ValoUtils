import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/** shadcn/ui Switch at the app's 32×18 size; purple when on. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer press-flat inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-(--control) outline-none transition-[background-color,box-shadow] duration-150 focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] disabled:cursor-wait disabled:opacity-50 data-[state=checked]:bg-(--accent)",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-3.5 translate-x-px rounded-full bg-[#d7d7de] transition-transform duration-150 data-[state=checked]:translate-x-3.5"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
