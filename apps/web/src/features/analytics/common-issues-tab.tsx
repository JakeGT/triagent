// Analytics → Common issues, for one project: the kinds of problem reviews keep finding there, each with
// what goes wrong and how to avoid it. The workspace's analysis model groups a branch's open findings
// into them when asked; people edit, hide, merge, delete and add them. Agents read them before they
// write code (the MCP tool list_common_issues), so the advice is worth getting right.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CATEGORIES, type Category, SEVERITIES } from "@triagent/shared";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field, FieldError, NativeSelect } from "@/components/field";
import { CategoryMark, SeverityMark } from "@/components/marks";
import { EmptyState } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Caution, NoModel, Writing } from "@/features/analysis/written";
import { errorMessage } from "@/lib/api";
import { CATEGORY_LABEL, plural, timeAgo } from "@/lib/format";
import { count } from "@/lib/insights-format";
import { type CommonIssue, type CommonIssueInput, type CommonIssues, commonIssuesQuery, patternApi, patternKeys } from "@/lib/patterns";
import { projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import type { AnalyticsSearch } from "./search";
import { Section } from "./sections";

const MAX = { title: 90, summary: 500, guidance: 800 };

/** Add one, or change one: its title, what goes wrong, how to avoid it, and its category. */
function EditDialog({
    project,
    branch,
    editing,
    close,
}: {
    project: string;
    branch: string;
    /** The one being changed; "new" to add one; null when closed. */
    editing: CommonIssue | "new" | null;
    close(): void;
}) {
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const current = editing && editing !== "new" ? editing : null;
    const [draft, setDraft] = useState<Required<Omit<CommonIssueInput, "hidden">>>({
        title: "",
        summary: "",
        guidance: "",
        category: null,
    });
    const [forId, setForId] = useState<string | null>(null);
    const key = editing === "new" ? "new" : (editing?.id ?? null);
    // A fresh form each time it opens.
    if (key !== forId) {
        setForId(key);
        setDraft({
            title: current?.title ?? "",
            summary: current?.summary ?? "",
            guidance: current?.guidance ?? "",
            category: current?.category ?? null,
        });
    }
    const save = useMutation({
        mutationFn: () => (current ? patternApi.update(ws, project, current.id, draft) : patternApi.create(ws, project, draft)),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: patternKeys.list(ws, project, branch) });
            toast.success(current ? "Common issue saved." : "Common issue added.");
            close();
        },
    });
    return (
        <Dialog
            open={editing !== null}
            onOpenChange={(next) => {
                if (!next) {
                    save.reset();
                    close();
                }
            }}
        >
            <DialogContent>
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{current ? "Edit common issue" : "Add a common issue"}</DialogTitle>
                        <DialogDescription>
                            People and agents read this before they write code here. Say what goes wrong, and what to do instead.
                        </DialogDescription>
                    </DialogHeader>
                    <Field label="Title" hint="A few words that name the cause, like “Row-level security missing on new tables”.">
                        {(p) => (
                            <Input
                                {...p}
                                value={draft.title}
                                maxLength={MAX.title}
                                required
                                autoComplete="off"
                                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                            />
                        )}
                    </Field>
                    <Field label="What goes wrong">
                        {(p) => (
                            <Textarea
                                {...p}
                                rows={3}
                                value={draft.summary}
                                maxLength={MAX.summary}
                                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                            />
                        )}
                    </Field>
                    <Field label="How to avoid it" hint="As instructions: what someone writing code here should do.">
                        {(p) => (
                            <Textarea
                                {...p}
                                rows={3}
                                value={draft.guidance}
                                maxLength={MAX.guidance}
                                onChange={(e) => setDraft({ ...draft, guidance: e.target.value })}
                            />
                        )}
                    </Field>
                    <Field label="Category" width="md">
                        {(p) => (
                            <NativeSelect
                                {...p}
                                value={draft.category ?? ""}
                                onChange={(e) => setDraft({ ...draft, category: (e.target.value || null) as Category | null })}
                            >
                                <option value="">None</option>
                                {CATEGORIES.map((c) => (
                                    <option key={c} value={c}>
                                        {CATEGORY_LABEL[c]}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    <FieldError message={save.error ? errorMessage(save.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={save.isPending || draft.title.trim().length < 4}>
                            {save.isPending ? "Saving…" : current ? "Save" : "Add"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Put everything under one common issue under another. */
function MergeDialog({
    project,
    branch,
    from,
    others,
    close,
}: {
    project: string;
    branch: string;
    from: CommonIssue | null;
    others: CommonIssue[];
    close(): void;
}) {
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const [into, setInto] = useState("");
    const merge = useMutation({
        mutationFn: () => patternApi.merge(ws, project, from?.id ?? "", into),
        onSuccess: async (to) => {
            await queryClient.invalidateQueries({ queryKey: patternKeys.list(ws, project, branch) });
            toast.success(`Merged into ${to.title}.`);
            setInto("");
            close();
        },
    });
    return (
        <Dialog
            open={from !== null}
            onOpenChange={(next) => {
                if (!next) {
                    merge.reset();
                    setInto("");
                    close();
                }
            }}
        >
            <DialogContent>
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (into) merge.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Merge “{from?.title}”</DialogTitle>
                        <DialogDescription>
                            Its {plural(from?.total ?? 0, "finding")} go under the one you choose, and this one is deleted. The other keeps
                            its own title and advice.
                        </DialogDescription>
                    </DialogHeader>
                    <Field label="Merge into">
                        {(p) => (
                            <NativeSelect {...p} value={into} onChange={(e) => setInto(e.target.value)} required>
                                <option value="">Choose a common issue</option>
                                {others.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.title}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                    <FieldError message={merge.error ? errorMessage(merge.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={merge.isPending || !into}>
                            {merge.isPending ? "Merging…" : "Merge"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Row({
    item,
    project,
    branch,
    canMerge,
    onEdit,
    onMerge,
}: {
    item: CommonIssue;
    project: string;
    branch: string;
    canMerge: boolean;
    onEdit(): void;
    onMerge(): void;
}) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const refresh = () => queryClient.invalidateQueries({ queryKey: patternKeys.list(ws, project, branch) });
    const hide = useMutation({
        mutationFn: () => patternApi.update(ws, project, item.id, { hidden: !item.hidden }),
        onSuccess: refresh,
        onError: (err) => toast.error(errorMessage(err)),
    });
    const severities = SEVERITIES.filter((s) => item.openBySeverity[s] > 0);
    return (
        <li className="grid gap-3 rounded-lg border bg-card p-4" data-testid="common-issue">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="grid gap-1">
                    <h3 className="text-base leading-snug font-semibold">{item.title}</h3>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        {item.category && <CategoryMark category={item.category} />}
                        {severities.map((s) => (
                            <span key={s} className="inline-flex items-center gap-1 tabular-nums">
                                {item.openBySeverity[s]} <SeverityMark severity={s} />
                            </span>
                        ))}
                        {item.hidden && <Badge variant="outline">Hidden from agents</Badge>}
                    </p>
                </div>
                <p className="text-sm text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">{count(item.open)} open</span> on {branch} · {count(item.total)} in all
                </p>
            </div>
            <dl className="grid max-w-measure gap-2 text-[0.9375rem] leading-relaxed">
                {item.summary && (
                    <div>
                        <dt className="text-sm font-medium text-muted-foreground">What goes wrong</dt>
                        <dd>{item.summary}</dd>
                    </div>
                )}
                <div>
                    <dt className="text-sm font-medium text-muted-foreground">How to avoid it</dt>
                    <dd>{item.guidance || <span className="text-muted-foreground">No advice yet. Edit this to add some.</span>}</dd>
                </div>
            </dl>
            {item.files.length > 0 && (
                <p className="font-mono text-xs break-all text-muted-foreground">
                    {item.files
                        .slice(0, 3)
                        .map((f) => f.path)
                        .join(" · ")}
                    {item.files.length > 3 && " · …"}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {item.open > 0 && (
                    <Button asChild variant="outline" size="sm">
                        <Link
                            to="/w/$ws/p/$project/issues"
                            params={{ ws, project }}
                            search={{ branch, pattern: item.id, status: ["open", "in_progress"] } as never}
                        >
                            See its {plural(item.open, "open finding")}
                        </Link>
                    </Button>
                )}
                {can("triage") && (
                    <>
                        <Button variant="ghost" size="sm" onClick={onEdit}>
                            Edit
                        </Button>
                        {canMerge && (
                            <Button variant="ghost" size="sm" onClick={onMerge}>
                                Merge into…
                            </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => hide.mutate()} disabled={hide.isPending}>
                            {item.hidden ? "Show to agents" : "Hide from agents"}
                        </Button>
                        <ConfirmAction
                            trigger={
                                <Button variant="ghost" size="sm">
                                    Delete
                                </Button>
                            }
                            title={`Delete “${item.title}”?`}
                            description={`Its ${plural(item.total, "finding")} stay as they are, under no common issue. The advice is deleted.`}
                            confirmLabel="Delete common issue"
                            onConfirm={async () => {
                                await patternApi.remove(ws, project, item.id);
                                await refresh();
                            }}
                        />
                    </>
                )}
            </div>
        </li>
    );
}

/** What there is to group, the button that asks for it, and how the last asking went. */
function Grouping({ project, data }: { project: string; data: CommonIssues }) {
    const { ws, can } = useWorkspace();
    const queryClient = useQueryClient();
    const group = useMutation({
        mutationFn: () => patternApi.group(ws, project, data.branch),
        onSettled: () => queryClient.invalidateQueries({ queryKey: patternKeys.list(ws, project, data.branch) }),
    });
    const g = data.grouping;
    const r = g?.status === "done" ? g.result : null;
    return (
        <div className="grid gap-2" data-testid="grouping">
            <p className="text-sm">
                {data.open === 0
                    ? `No findings are open on ${data.branch}.`
                    : data.ungrouped === 0
                      ? `All ${plural(data.open, "open finding")} on ${data.branch} ${data.open === 1 ? "is" : "are"} under a common issue.`
                      : `${count(data.ungrouped)} of ${plural(data.open, "open finding")} on ${data.branch} ${data.ungrouped === 1 ? "isn't" : "aren't"} under a common issue yet.`}
            </p>
            {g?.status === "running" ? (
                <Writing analysis={g} />
            ) : (
                can("triage") &&
                data.ungrouped > 0 &&
                (data.model.ready ? (
                    <div>
                        <Button
                            onClick={() => group.mutate()}
                            disabled={group.isPending}
                            variant={data.items.length ? "outline" : "default"}
                        >
                            {group.isPending ? "Asking…" : data.items.length ? "Group the rest" : "Find common issues"}
                        </Button>
                    </div>
                ) : (
                    <NoModel model={data.model} />
                ))
            )}
            {group.isError && (
                <p className="text-sm text-destructive" role="alert">
                    {errorMessage(group.error)}
                </p>
            )}
            {g?.status === "failed" && (
                <p className="text-sm text-muted-foreground" data-testid="analysis-failed">
                    {g.error}
                </p>
            )}
            {r && (
                <p className="text-xs text-muted-foreground">
                    {g?.model?.label ?? "A model"} last looked {timeAgo(g?.finishedAt)}: {plural(r.created ?? 0, "new common issue")},{" "}
                    {plural(r.grouped ?? 0, "finding")} put under one
                    {r.left ? `, ${count(r.left)} left for next time` : ""}. It read the findings' titles and places, not the code.
                </p>
            )}
            {r?.warning && <Caution>{r.warning}</Caution>}
        </div>
    );
}

export function CommonIssuesTab({ search }: { search: AnalyticsSearch }) {
    const { ws, can } = useWorkspace();
    const projects = useQuery(projectsQuery(ws));
    const project = search.project;
    const branch = search.branch ?? projects.data?.find((p) => p.slug === project)?.defaultBranch;
    const query = useQuery({ ...commonIssuesQuery(ws, project ?? "", branch ?? ""), enabled: Boolean(project && branch) });
    const [editing, setEditing] = useState<CommonIssue | "new" | null>(null);
    const [merging, setMerging] = useState<CommonIssue | null>(null);
    const data = query.data;
    return (
        <Section
            id="common-issues"
            title="Common issues"
            description="The kinds of problem reviews keep finding in a project, with how to avoid each. Coding agents read these before they write code there, and each finding says which one it's under."
        >
            {!project || !branch ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="common-issues-note">
                    Choose a project above to see its common issues.
                </p>
            ) : query.isError ? (
                <p className="text-sm text-destructive" role="alert">
                    {errorMessage(query.error)}
                </p>
            ) : !data ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
                <>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <Grouping project={project} data={data} />
                        {can("triage") && (
                            <Button variant="outline" onClick={() => setEditing("new")}>
                                Add one by hand
                            </Button>
                        )}
                    </div>
                    {data.items.length ? (
                        <ul className="grid gap-3">
                            {data.items.map((item) => (
                                <Row
                                    key={item.id}
                                    item={item}
                                    project={project}
                                    branch={data.branch}
                                    canMerge={data.items.length > 1}
                                    onEdit={() => setEditing(item)}
                                    onMerge={() => setMerging(item)}
                                />
                            ))}
                        </ul>
                    ) : (
                        <EmptyState title="No common issues yet">
                            Once a review has findings, a model can group them by cause, or you can add one by hand: something reviews keep
                            finding here, and what to do instead.
                        </EmptyState>
                    )}
                    <EditDialog project={project} branch={data.branch} editing={editing} close={() => setEditing(null)} />
                    <MergeDialog
                        project={project}
                        branch={data.branch}
                        from={merging}
                        others={data.items.filter((o) => o.id !== merging?.id)}
                        close={() => setMerging(null)}
                    />
                </>
            )}
        </Section>
    );
}
