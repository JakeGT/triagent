import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Marks the tutorial's example project, and its made-up runs, wherever they appear. */
export function ExampleBadge({ className }: { className?: string }) {
    return (
        <Badge variant="outline" className={cn("border-primary/40 font-normal text-primary", className)} data-testid="example-badge">
            Example
        </Badge>
    );
}
