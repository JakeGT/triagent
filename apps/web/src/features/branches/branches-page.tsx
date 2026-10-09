// Branches & reports: every branch with a report, uploading a new one, each branch's report history,
// and moving or deleting a branch's report and triage.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { History, MoveRight, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { CheckField, Field, FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { EmptyState, Page, PageHeader, PageMeta } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NewReviewButton } from "@/features/runs/new-review-button";
import { StartReview } from "@/features/runs/start-review";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDateTime, plural, timeAgo } from "@/lib/format";
import { branchesQuery, historyQuery, keys } from "@/lib/queries";
import { useCan, useProject } from "@/lib/session";
import type { Branch } from "@/lib/types";
import { UploadReport } from "./upload-report";

export function BranchesPage() {
    const { ws, slug, project } = useProject();
    const can = useCan();
    const queryClient = useQueryClient();
    const branches = useQuery(branchesQuery(ws, slug));
    const [history, setHistory] = useState<string | null>(null);
    const [moving, setMoving] = useState<Branch | null>(null);

    const remove = useMutation({
        mutationFn: (branch: string) => api.post(`${paths.project(ws, slug)}/branches/delete`, { branch, confirm: true }),
        onSuccess: (_r, branch) => {
            toast.success(`Deleted the report for ${branch}.`);
            void queryClient.invalidateQueries({ queryKey: keys.project(ws, slug) });
            void queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
        },
    });

    return (
        <Page>
            <PageMeta title={`Branches & reports · ${project.name}`} />
            <PageHeader
                title="Branches & reports"
                description="Each branch has its own report and its own triage."
                actions={<NewReviewButton />}
            />
            {can("upload") && <UploadReport />}

            <section aria-labelledby="branches-heading" className="grid gap-2" data-tour="branches-table">
                <h2 id="branches-heading" className="section-title">
                    Branches with a report
                </h2>
                {branches.isPending ? (
                    <LoadingRows rows={4} />
                ) : branches.isError ? (
                    <LoadError error={branches.error} onRetry={() => branches.refetch()} title="Couldn't load the branches" />
                ) : branches.data.items.length === 0 ? (
                    <EmptyState title="No reports yet">
                        {can("upload")
                            ? "Upload the JSON report Open Code Review wrote, above."
                            : "Someone with upload access needs to upload a report."}
                    </EmptyState>
                ) : (
                    <TableFrame>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead scope="col">Branch</TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Issues
                                    </TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Unresolved
                                    </TableHead>
                                    <TableHead scope="col" className="text-end">
                                        In progress
                                    </TableHead>
                                    <TableHead scope="col" className="text-end">
                                        Done
                                    </TableHead>
                                    <TableHead scope="col">Report</TableHead>
                                    <TableHead scope="col">
                                        <span className="sr-only">Actions</span>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {branches.data.items.map((b) => (
                                    <TableRow key={b.name} data-testid={`branch-${b.name}`}>
                                        <TableCell>
                                            <Link
                                                to="/w/$ws/p/$project/overview"
                                                params={{ ws, project: slug }}
                                                search={{ branch: b.isDefault ? undefined : b.name }}
                                                className="font-mono text-xs font-medium hover:underline"
                                            >
                                                {b.name}
                                            </Link>
                                            {b.isDefault && (
                                                <Badge variant="secondary" className="ms-2">
                                                    default
                                                </Badge>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-end tabular-nums">{b.issues}</TableCell>
                                        <TableCell className="text-end tabular-nums">{b.unresolved}</TableCell>
                                        <TableCell className="text-end tabular-nums">{b.inProgress}</TableCell>
                                        <TableCell className="text-end tabular-nums">{b.done}</TableCell>
                                        <TableCell className="min-w-56 text-xs whitespace-normal">
                                            <span className="font-mono">{b.fileName}</span>
                                            <span className="block text-muted-foreground">
                                                {b.scope === "diff" ? "Changes only" : "Whole codebase"} · {b.uploadedBy},{" "}
                                                <time dateTime={b.uploadedAt} title={formatDateTime(b.uploadedAt)}>
                                                    {timeAgo(b.uploadedAt)}
                                                </time>
                                                {b.commit && (
                                                    <>
                                                        {" "}
                                                        · <span className="font-mono">{b.commit.slice(0, 10)}</span>
                                                    </>
                                                )}
                                            </span>
                                            <GithubState branch={b} />
                                        </TableCell>
                                        <TableCell>
                                            <span className="flex flex-wrap justify-end gap-1">
                                                {b.github?.onGitHub && !b.github.current && (
                                                    <StartReview
                                                        defaults={
                                                            b.isDefault
                                                                ? { kind: "full", branch: b.name }
                                                                : { kind: "changes", branch: b.name, base: branches.data.defaultBranch }
                                                        }
                                                        trigger={
                                                            <Button variant="ghost" size="sm">
                                                                <RotateCw /> Review again<span className="sr-only"> {b.name}</span>
                                                            </Button>
                                                        }
                                                    />
                                                )}
                                                <Button variant="ghost" size="sm" onClick={() => setHistory(b.name)}>
                                                    <History /> History<span className="sr-only"> of {b.name}</span>
                                                </Button>
                                                {can("configure") && (
                                                    <Button variant="ghost" size="sm" onClick={() => setMoving(b)}>
                                                        <MoveRight /> Move<span className="sr-only"> {b.name}</span>
                                                    </Button>
                                                )}
                                                {can("configure") && !b.isDefault && (
                                                    <ConfirmAction
                                                        trigger={
                                                            <Button variant="ghost" size="sm">
                                                                <Trash2 /> Delete<span className="sr-only"> {b.name}</span>
                                                            </Button>
                                                        }
                                                        title={`Delete the report for ${b.name}?`}
                                                        description={
                                                            <>
                                                                <p>
                                                                    Its report and triage are moved to the project's archive and the branch
                                                                    disappears from every page.
                                                                </p>
                                                                {b.unresolved > 0 && (
                                                                    <p className="mt-2 font-medium">
                                                                        It still has {plural(b.unresolved, "unresolved issue")}.
                                                                    </p>
                                                                )}
                                                            </>
                                                        }
                                                        confirmLabel="Delete branch report"
                                                        typeToConfirm={b.name}
                                                        onConfirm={() => remove.mutateAsync(b.name)}
                                                    />
                                                )}
                                            </span>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableFrame>
                )}
            </section>

            {branches.data?.github && branches.data.github.notReviewed.length > 0 && (
                <section aria-labelledby="not-reviewed-heading" className="grid gap-2">
                    <h2 id="not-reviewed-heading" className="section-title">
                        On GitHub, not reviewed yet
                    </h2>
                    <ul className="grid gap-1" data-testid="not-reviewed">
                        {branches.data.github.notReviewed.map((name) => (
                            <li key={name} className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-mono text-xs">{name}</span>
                                <StartReview
                                    defaults={{ kind: "changes", branch: name, base: branches.data.defaultBranch }}
                                    trigger={
                                        <Button variant="ghost" size="sm">
                                            Review<span className="sr-only"> {name}</span>
                                        </Button>
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <HistoryDialog branch={history} onClose={() => setHistory(null)} />
            <MoveDialog branch={moving} onClose={() => setMoving(null)} />
        </Page>
    );
}

function HistoryDialog({ branch, onClose }: { branch: string | null; onClose(): void }) {
    const { ws, slug } = useProject();
    const history = useQuery({ ...historyQuery(ws, slug, branch ?? ""), enabled: Boolean(branch) });
    const current = history.data?.current?.upload;
    return (
        <Dialog open={Boolean(branch)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Report history of {branch}</DialogTitle>
                    <DialogDescription>The current report and the ones it replaced, newest first.</DialogDescription>
                </DialogHeader>
                {history.isPending ? (
                    <LoadingRows rows={3} />
                ) : history.isError ? (
                    <LoadError error={history.error} onRetry={() => history.refetch()} />
                ) : (
                    <ol className="grid max-h-96 gap-2 overflow-y-auto text-sm">
                        {current && (
                            <li className="rounded-md border p-2">
                                <span className="font-mono">{current.fileName}</span> <Badge variant="secondary">current</Badge>
                                <span className="block text-xs text-muted-foreground">
                                    Uploaded by {current.uploadedBy} on {formatDateTime(current.uploadedAt)}
                                    {current.commit ? ` at ${current.commit.slice(0, 10)}` : ""}
                                </span>
                            </li>
                        )}
                        {history.data.archived.map((a) => (
                            <li key={`${a.upload.id}-${a.archivedAt}`} className="rounded-md border p-2">
                                <span className="font-mono">{a.upload.fileName}</span>, {plural(a.findings, "finding")}
                                <span className="block text-xs text-muted-foreground">
                                    Uploaded by {a.upload.uploadedBy} on {formatDateTime(a.upload.uploadedAt)}
                                    {a.upload.commit ? ` at ${a.upload.commit.slice(0, 10)}` : ""}.{" "}
                                    {a.reason === "deleted" ? "Deleted" : "Replaced"} {formatDateTime(a.archivedAt)}.
                                </span>
                            </li>
                        ))}
                        {!current && history.data.archived.length === 0 && <li className="text-muted-foreground">No reports.</li>}
                    </ol>
                )}
            </DialogContent>
        </Dialog>
    );
}

function MoveDialog({ branch, onClose }: { branch: Branch | null; onClose(): void }) {
    const { ws, slug } = useProject();
    const queryClient = useQueryClient();
    const [to, setTo] = useState("");
    const [makeDefault, setMakeDefault] = useState(false);
    const [open, setOpen] = useState<string | null>(null);
    // Start fresh each time a different branch is opened.
    if (branch && open !== branch.name) {
        setOpen(branch.name);
        setTo("");
        setMakeDefault(branch.isDefault);
    }
    const close = () => {
        setOpen(null);
        move.reset();
        onClose();
    };
    const move = useMutation({
        mutationFn: () =>
            api.post<{ from: string; to: string; defaultBranch: string }>(`${paths.project(ws, slug)}/branches/move`, {
                from: branch?.name,
                to: to.trim(),
                makeDefault,
            }),
        onSuccess: (r) => {
            toast.success(`Moved ${r.from} to ${r.to}.`);
            void queryClient.invalidateQueries({ queryKey: keys.project(ws, slug) });
            void queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
            close();
        },
    });
    return (
        <Dialog
            open={Boolean(branch)}
            onOpenChange={(next) => {
                if (!next) close();
            }}
        >
            <DialogContent>
                <form
                    className="grid gap-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (to.trim()) move.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Move {branch?.name}</DialogTitle>
                        <DialogDescription>
                            Moves the report, its triage and its history to another branch name, for a report uploaded to the wrong branch.
                        </DialogDescription>
                    </DialogHeader>
                    <Field label="New branch name">
                        {(p) => <Input {...p} value={to} onChange={(e) => setTo(e.target.value)} className="font-mono" required />}
                    </Field>
                    <CheckField label="Make it the project's default branch">
                        {(p) => <Checkbox {...p} checked={makeDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />}
                    </CheckField>
                    <FieldError message={move.error ? errorMessage(move.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={move.isPending || !to.trim()}>
                            Move branch
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** How the branch's report compares with the branch on GitHub. */
function GithubState({ branch }: { branch: Branch }) {
    const g = branch.github;
    if (!g) return null;
    if (!g.onGitHub) return <span className="block text-muted-foreground">Not on GitHub</span>;
    if (g.current) return <span className="block text-st-resolved">Up to date with GitHub</span>;
    return (
        <span className="block font-medium text-sev-medium">
            Out of date
            {g.behind !== null ? `: ${plural(g.behind, "commit")} behind` : ": GitHub has newer commits"}
            {g.diverged ? " (the branch was rewritten)" : ""}
        </span>
    );
}
