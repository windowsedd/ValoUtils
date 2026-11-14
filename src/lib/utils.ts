import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class helper: conditional classes, with later Tailwind classes winning. */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
