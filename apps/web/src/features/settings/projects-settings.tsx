import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Field, FieldError } from "@/components/field";
import { LoadError, LoadingRows } from "@/components/load-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, paths } from "@/lib/api";
import { keys, projectsQuery } from "@/lib/queries";
import { safeHref } from "@/lib/safe-href";
import { useWorkspace } from "@/lib/session";
import type { Project } from "@/lib/types";
import { ReadOnlyNote, SettingsPage, SettingsSection } from "./settings-page";

const EMPTY = { slug: "", name: "", repoUrl: "", defaultBranch: "" };

function CreateProject() {
    const { ws } = useWorkspace();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [form, setForm] = useState(EMPTY);
    const create = useMutation({
        mutationFn: () =>
            api.post<Project>(`${paths.workspace(ws)}/projects`, {
                slug: form.slug.trim().toLowerCase(),
                ...(form.name.trim() ? { name: form.name.trim() } : {}),
                ...(form.repoUrl.trim() ? { repoUrl: form.repoUrl.trim() } : {}),
                ...(form.defaultBranch.trim() ? { defaultBranch: form.defaultBranch.trim() } : {}),
            }),
        onSuccess: async (p) => {
            await queryClient.invalidateQueries({ queryKey: keys.projects(ws) });
            setForm(EMPTY);
            toast.success(`Project ${p.name} created. Upload a report to start.`);
            await navigate({ to: "/w/$ws/p/$project/branches", params: { ws, project: p.slug } });
        },
    });
    return (
        <SettingsSection title="Create a project" description="One project per codebase. You can upload reports to it straight away.">
            <form
                className="grid gap-4 sm:grid-cols-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                }}
            >
                <Field label="Name">
                    {(p) => <Input {...p} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} />}
                </Field>
                <Field label="Project id" hint="Used in addresses: lower-case letters, numbers and dashes.">
                    {(p) => (
                        <Input
                            {...p}
                            value={form.slug}
                            onChange={(e) => setForm({ ...form, slug: e.target.value })}
                            required
                            maxLength={40}
                            spellCheck={false}
                            autoComplete="off"
                            className="font-mono"
                        />
                    )}
                </Field>
                <Field label="Repository URL" hint="Optional, e.g. https://github.com/acme/app">
                    {(p) => (
                        <Input
                            {...p}
                            type="url"
                            value={form.repoUrl}
                            onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                            maxLength={300}
                        />
                    )}
                </Field>
                <Field label="Default branch" hint="Optional; main if left empty.">
                    {(p) => (
                        <Input
                            {...p}
                            value={form.defaultBranch}
                            onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
                            maxLength={200}
                            className="font-mono"
                        />
                    )}
                </Field>
                <FieldError message={create.error ? errorMessage(create.error) : null} className="sm:col-span-2" />
                <div className="sm:col-span-2">
                    <Button type="submit" disabled={create.isPending || !form.slug.trim()}>
                        {create.isPending ? "Creating…" : "Create project"}
                    </Button>
                </div>
            </form>
        </SettingsSection>
    );
}

export function ProjectsSettings() {
    const { ws, workspace, can } = useWorkspace();
    const query = useQuery(projectsQuery(ws));
    return (
        <SettingsPage title="Projects" description={`The codebases in ${workspace.name}.`}>
            {query.isError ? (
                <LoadError error={query.error} onRetry={() => query.refetch()} />
            ) : query.isPending ? (
                <LoadingRows rows={3} />
            ) : query.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects yet.</p>
            ) : (
                <div className="rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Project</TableHead>
                                <TableHead>Repository</TableHead>
                                <TableHead>Default branch</TableHead>
                                <TableHead className="text-end">Branches</TableHead>
                                <TableHead className="text-end">Findings</TableHead>
                                <TableHead>
                                    <span className="sr-only">Links</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {query.data.map((p) => {
                                const repo = safeHref(p.repoUrl);
                                return (
                                    <TableRow key={p.id}>
                                        <TableCell>
                                            <Link
                                                to="/w/$ws/p/$project/overview"
                                                params={{ ws, project: p.slug }}
                                                className="font-medium underline-offset-2 hover:underline"
                                            >
                                                {p.name}
                                            </Link>
                                            <div className="font-mono text-xs text-muted-foreground">{p.slug}</div>
                                        </TableCell>
                                        <TableCell className="max-w-56 truncate text-xs">
                                            {repo ? (
                                                <a href={repo} target="_blank" rel="noopener noreferrer" className="underline">
                                                    {p.repoUrl}
                                                </a>
                                            ) : (
                                                (p.repoUrl ?? <span className="text-muted-foreground">None</span>)
                                            )}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">{p.defaultBranch}</TableCell>
                                        <TableCell className="text-end tabular-nums">{p.branches}</TableCell>
                                        <TableCell className="text-end tabular-nums">{p.findings}</TableCell>
                                        <TableCell>
                                            <Link
                                                to="/w/$ws/p/$project/settings/general"
                                                params={{ ws, project: p.slug }}
                                                className="text-sm underline"
                                            >
                                                Settings<span className="sr-only"> for {p.name}</span>
                                            </Link>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}
            {can("configure") ? <CreateProject /> : <ReadOnlyNote>Only admins of this workspace can create projects.</ReadOnlyNote>}
        </SettingsPage>
    );
}
