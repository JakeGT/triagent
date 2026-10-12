// A finished review's page: what a model has written about it. What it changed on its branch, and (for
// a review two or more models finished) how its models compare. Nothing is written until someone asks,
// unless the workspace chose otherwise in Settings → Analysis.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { analysisKeys, runAnalysisQuery, writeForRun } from "@/lib/analysis";
import { errorMessage } from "@/lib/api";
import { Written } from "./written";

export function RunAnalysis({ ws, runId }: { ws: string; runId: string }) {
    const queryClient = useQueryClient();
    const { data } = useQuery(runAnalysisQuery(ws, runId));
    const write = useMutation({
        mutationFn: (kind: "comparison" | "summary") => writeForRun(ws, runId, kind),
        onSettled: () => queryClient.invalidateQueries({ queryKey: analysisKeys.all(ws) }),
    });
    if (!data) return null;
    const parts = (
        [
            [
                "summary",
                "What this review changed",
                "Write a summary",
                "What's new, what's gone and what came back since the review before it.",
            ],
            [
                "comparison",
                "Its models compared",
                "Write a comparison",
                "What each model was good at, where they disagreed, and whether one is worth dropping.",
            ],
        ] as const
    ).filter(([kind]) => !data.unavailable[kind]);
    if (!parts.length) return null;
    return (
        <section aria-labelledby="run-analysis-title" className="grid gap-3" data-testid="run-analysis">
            <h3 id="run-analysis-title" className="text-sm font-medium">
                Written about this review
            </h3>
            <div className="grid gap-4 rounded-md border p-4">
                {parts.map(([kind, title, ask, empty], i) => (
                    <div key={kind} className={i ? "grid gap-2 border-t pt-4" : "grid gap-2"} data-testid={`written-${kind}`}>
                        <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
                        <Written
                            analysis={data[kind]}
                            model={data.model}
                            ask={ask}
                            empty={empty}
                            onAsk={() => write.mutate(kind)}
                            asking={write.isPending && write.variables === kind}
                            error={write.isError && write.variables === kind ? errorMessage(write.error) : null}
                        />
                    </div>
                ))}
            </div>
        </section>
    );
}
