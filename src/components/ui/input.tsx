import * as React from "react";
import { cn } from "@/lib/utils";

/** shadcn/ui Input in ValoUtils' compact field style. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"h-7 w-full min-w-0 rounded-[6px] border border-(--border) bg-(--control) px-2 text-[12px] text-(--text-primary) outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-(--text-muted) hover:border-[#3c3c42] focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_2px_var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 read-only:text-(--text-secondary) aria-invalid:border-(--signal-neg)",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
