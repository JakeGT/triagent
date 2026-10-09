import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { lineDiff } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

export function CodeBlock({ code, className }: { code: string; className?: string }) {
    return (
        <pre
            className={cn("max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed", className)}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
            tabIndex={0}
        >
            <code>{code}</code>
        </pre>
    );
}

/** The finding's code and the reviewer's suggested fix: as a diff when there are both. */
export function CodeView({
    existing,
    suggestion,
    startLine,
}: {
    existing: string | null;
    suggestion: string | null;
    startLine?: number | null;
}) {
    const [tab, setTab] = useState(existing && suggestion ? "diff" : suggestion ? "suggestion" : "existing");
    // Kept between renders: the page re-renders on every keystroke of a note being typed.
    const diff = useMemo(() => (existing && suggestion ? lineDiff(existing, suggestion) : []), [existing, suggestion]);
    if (!existing && !suggestion) return null;
    if (!(existing && suggestion)) {
        return (
            <section className="grid gap-1.5">
                <h3 className="text-sm font-medium">{existing ? "Code" : "Suggested code"}</h3>
                <CodeBlock code={existing || suggestion || ""} />
            </section>
        );
    }
    return (
        <section className="grid gap-1.5">
            <h3 className="text-sm font-medium">Code and suggested fix</h3>
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList>
                    <TabsTrigger value="diff">Diff</TabsTrigger>
                    <TabsTrigger value="existing">Current{startLine ? ` (line ${startLine})` : ""}</TabsTrigger>
                    <TabsTrigger value="suggestion">Suggested</TabsTrigger>
                </TabsList>
                <TabsContent value="diff">
                    <pre
                        className="max-h-96 overflow-auto rounded-md border bg-muted/50 py-2 font-mono text-xs leading-relaxed"
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                        tabIndex={0}
                    >
                        <code className="block min-w-fit">
                            {diff.map((line, i) => (
                                <span
                                    // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed diff
                                    key={i}
                                    className={cn(
                                        "block px-3 whitespace-pre",
                                        line.kind === "add" && "bg-diff-add",
                                        line.kind === "del" && "bg-diff-del",
                                    )}
                                >
                                    <span className="me-2 inline-block w-3 text-muted-foreground select-none" aria-hidden="true">
                                        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                                    </span>
                                    {line.kind === "add" && <span className="sr-only">Added: </span>}
                                    {line.kind === "del" && <span className="sr-only">Removed: </span>}
                                    {line.text || " "}
                                </span>
                            ))}
                        </code>
                    </pre>
                </TabsContent>
                <TabsContent value="existing">
                    <CodeBlock code={existing} />
                </TabsContent>
                <TabsContent value="suggestion">
                    <CodeBlock code={suggestion} />
                </TabsContent>
            </Tabs>
        </section>
    );
}
