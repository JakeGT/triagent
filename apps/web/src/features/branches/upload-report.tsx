// Uploading a report: choose the file, see what it would change, then confirm. Nothing is saved until
// the second step.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SEVERITIES } from "@triagent/shared";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Field, FieldError } from "@/components/field";
import { SeverityBar } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage, paths } from "@/lib/api";
import { plural, SEVERITY_LABEL } from "@/lib/format";
import { keys } from "@/lib/queries";
import { useProject } from "@/lib/session";
import type { UploadPreview, UploadResult } from "@/lib/types";

interface Prepared {
    branch: string;
    commit?: string;
    fileName: string;
    scope: "full" | "diff";
    report: unknown;
}

export function UploadReport() {
    const { ws, slug, project } = useProject();
    const queryClient = useQueryClient();
    const fileRef = useRef<HTMLInputElement>(null);
    const scopeName = useId();
    const [branch, setBranch] = useState(project.defaultBranch);
    const [commit, setCommit] = useState("");
    const [scope, setScope] = useState<"full" | "diff">("full");
    const [fileError, setFileError] = useState<string | null>(null);
    const [prepared, setPrepared] = useState<Prepared | null>(null);
    const [preview, setPreview] = useState<UploadPreview | null>(null);

    const clearPreview = () => {
        setPrepared(null);
        setPreview(null);
        setFileError(null);
    };
    const reset = () => {
        clearPreview();
        if (fileRef.current) fileRef.current.value = "";
    };

    const previewIt = useMutation({
        mutationFn: (body: Prepared) => api.post<UploadPreview>(`${paths.project(ws, slug)}/reports/preview`, body),
        onSuccess: setPreview,
    });
    const upload = useMutation({
        mutationFn: (body: Prepared & { confirm?: boolean }) => api.post<UploadResult>(`${paths.project(ws, slug)}/reports`, body),
        onSuccess: (r) => {
            toast.success(`Uploaded to ${r.branch}: ${plural(r.next.issues, "finding")}${r.reopened ? `, ${r.reopened} reopened` : ""}.`);
            void queryClient.invalidateQueries({ queryKey: keys.project(ws, slug) });
            void queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
            reset();
        },
    });

    const prepare = async () => {
        setFileError(null);
        setPreview(null);
        previewIt.reset();
        upload.reset();
        const file = fileRef.current?.files?.[0];
        if (!branch.trim()) {
            setFileError("Enter the branch the report is for.");
            return;
        }
        if (!file) {
            setFileError("Choose the JSON file Open Code Review wrote.");
            return;
        }
        let report: unknown;
        try {
            report = JSON.parse(await file.text());
        } catch {
            setFileError(`${file.name} isn't valid JSON. Choose the JSON report Open Code Review wrote.`);
            return;
        }
        const body: Prepared = {
            branch: branch.trim(),
            ...(commit.trim() ? { commit: commit.trim() } : {}),
            fileName: file.name.slice(0, 200),
            scope,
            report,
        };
        setPrepared(body);
        previewIt.mutate(body);
    };

    const p = preview;
    return (
        <section aria-labelledby="upload-heading" className="grid gap-3 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="upload-heading" className="font-semibold">
                    Upload a report
                </h2>
                <Link to="/w/$ws/agents" params={{ ws }} search={{ project: slug }} className="text-sm underline">
                    Upload from CI instead
                </Link>
            </div>
            <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    void prepare();
                }}
            >
                <Field label="Branch">
                    {(f) => <Input {...f} value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" required />}
                </Field>
                <Field label="Commit" hint="Optional: the commit that was reviewed.">
                    {(f) => (
                        <Input {...f} value={commit} onChange={(e) => setCommit(e.target.value)} className="font-mono" maxLength={40} />
                    )}
                </Field>
                <fieldset className="grid gap-3">
                    <legend className="mb-1.5 text-sm font-medium">What the review covered</legend>
                    <div className="flex items-center gap-2">
                        <input
                            type="radio"
                            id={`${scopeName}-full`}
                            name={scopeName}
                            checked={scope === "full"}
                            onChange={() => setScope("full")}
                            className="size-4 accent-primary"
                        />
                        <Label htmlFor={`${scopeName}-full`} className="font-normal">
                            The whole codebase
                        </Label>
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="radio"
                            id={`${scopeName}-diff`}
                            name={scopeName}
                            checked={scope === "diff"}
                            onChange={() => setScope("diff")}
                            className="size-4 accent-primary"
                        />
                        <Label htmlFor={`${scopeName}-diff`} className="font-normal">
                            Only the branch's changes
                        </Label>
                    </div>
                </fieldset>
                <Field label="Report file" error={fileError}>
                    {(f) => <Input {...f} ref={fileRef} type="file" accept=".json,application/json" onChange={clearPreview} />}
                </Field>
                <div className="sm:col-span-2">
                    <Button type="submit" disabled={previewIt.isPending}>
                        {previewIt.isPending ? "Checking…" : "Preview upload"}
                    </Button>
                </div>
            </form>
            <FieldError message={previewIt.error ? errorMessage(previewIt.error) : null} />

            {p && prepared && (
                <div className="grid gap-3 rounded-md border bg-background p-3 text-sm" data-testid="upload-preview">
                    <h3 className="font-medium">
                        What uploading {prepared.fileName} to <span className="font-mono">{p.branch}</span> would do
                    </h3>
                    {p.identical && <p>This is the same file as the branch's current report. Nothing will be reopened.</p>}
                    <ul className="grid gap-1">
                        <li>
                            {p.newBranch ? "A new branch, with " : "The new report has "}
                            {plural(p.next.issues, "finding")} in {plural(p.next.files, "file")} and {plural(p.next.tasks, "task")}
                            {": "}
                            {SEVERITIES.filter((s) => p.next.bySeverity[s])
                                .map((s) => `${p.next.bySeverity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
                                .join(", ") || "none"}
                            <SeverityBar counts={p.next.bySeverity} className="ms-2 inline-flex align-middle" />
                        </li>
                        {!p.newBranch && (
                            <>
                                <li>
                                    {plural(p.carriedOver, "finding")} carried over ({p.withTriage} with triage kept), {p.added} new.
                                </li>
                                <li>
                                    {plural(p.removed, "finding")} no longer reported
                                    {p.removedUnresolved ? `, ${p.removedUnresolved} of them still unresolved` : ""}.
                                </li>
                                {p.stillReportedResolved > 0 && (
                                    <li>
                                        {plural(p.stillReportedResolved, "resolved finding")} still reported:{" "}
                                        {p.reopen ? "they'll be reopened." : "they stay resolved."}
                                    </li>
                                )}
                            </>
                        )}
                        {p.keptAdded > 0 && <li>{plural(p.keptAdded, "finding")} added by hand will be kept.</li>}
                    </ul>
                    {p.requiresConfirmation && (
                        <p className="rounded-md border border-sev-medium/40 bg-sev-medium/10 p-2">
                            The current report ({p.current.fileName ?? "unnamed"}) still has{" "}
                            {plural(p.current.unresolved, "unresolved issue")}. Uploading replaces it; it's kept in the branch's report
                            history.
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            onClick={() => upload.mutate({ ...prepared, ...(p.requiresConfirmation ? { confirm: true } : {}) })}
                            disabled={upload.isPending}
                        >
                            {upload.isPending ? "Uploading…" : "Confirm upload"}
                        </Button>
                        <Button variant="ghost" onClick={reset}>
                            Cancel
                        </Button>
                    </div>
                    <FieldError message={upload.error ? errorMessage(upload.error) : null} />
                </div>
            )}
        </section>
    );
}
