import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names, letting later Tailwind classes win (from shadcn/ui). */
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/** Initials for an avatar: first letters of the first and last words. */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}
