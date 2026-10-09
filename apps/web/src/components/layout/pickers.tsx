// Workspace, project and branch pickers at the top of the rail. Each is a menu of links: choosing one
// is an explicit action, and nothing happens on focus or arrowing through the options.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown, FolderGit2, GitBranch, Plus, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ExampleBadge } from "@/components/example-badge";
import { Field, FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { openSetup } from "@/features/setup/setup-store";
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { branchesQuery, keys, projectsQuery } from "@/lib/queries";
import { useMe, useWorkspace } from "@/lib/session";
import { isExample } from "@/lib/tutorial";
import type { WorkspaceSummary } from "@/lib/types";

function PickerButton({
    icon,
    label,
    value,
    badge,
    ...props
}: { icon: React.ReactNode; label: string; value: string; badge?: React.ReactNode } & React.ComponentProps<typeof SidebarMenuButton>) {
    return (
        <SidebarMenuButton
            {...props}
            size="lg"
            className="h-11 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            tooltip={`${label}: ${value}`}
        >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background [&>svg]:size-4">{icon}</span>
            <span className="grid min-w-0 flex-1 text-start leading-tight">
                <span className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                    {label}
                    {badge}
                </span>
                <span className="truncate font-medium">{value}</span>
            </span>
            <ChevronsUpDown className="ms-auto size-4 opacity-60" aria-hidden="true" />
        </SidebarMenuButton>
    );
}

export function WorkspaceSwitcher() {
    const me = useMe();
    const { workspace } = useWorkspace();
    const { isMobile } = useSidebar();
    const [creating, setCreating] = useState(false);
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <PickerButton
                            icon={workspace.kind === "personal" ? <User /> : <Building2 />}
                            label="Workspace"
                            value={workspace.name}
                        />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-60" align="start" side={isMobile ? "bottom" : "right"}>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
                        {me.workspaces.map((w: WorkspaceSummary) => (
                            <DropdownMenuItem key={w.id} asChild>
                                <Link to="/w/$ws" params={{ ws: w.slug }}>
                                    {w.kind === "personal" ? <User /> : <Building2 />}
                                    <span className="flex-1 truncate">{w.name}</span>
                                    <span className="text-xs text-muted-foreground">{w.role}</span>
                                    {w.slug === workspace.slug && <Check aria-label="current" />}
                                </Link>
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setCreating(true)}>
                            <Plus /> Create an organisation…
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <CreateOrganisation open={creating} onOpenChange={setCreating} />
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

/**
 * A new organisation's name and id. Once it's made, it opens (a new workspace's guided setup follows:
 * `onCreated` decides).
 */
export function CreateOrganisationForm({
    onCreated,
    actions,
}: {
    onCreated(workspace: WorkspaceSummary): void | Promise<void>;
    /** Buttons before Create organisation (a dialog's Cancel). */
    actions?: ReactNode;
}) {
    const queryClient = useQueryClient();
    const [slug, setSlug] = useState("");
    const [name, setName] = useState("");
    const create = useMutation({
        mutationFn: () => api.post<WorkspaceSummary>(paths.workspaces, { slug: slug.trim().toLowerCase(), name: name.trim() || undefined }),
        onSuccess: async (w) => {
            await queryClient.invalidateQueries({ queryKey: keys.me });
            setSlug("");
            setName("");
            await onCreated(w);
        },
    });
    return (
        <form
            className="grid gap-form"
            onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
            }}
        >
            <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Id" hint="Used in addresses: lower-case letters, numbers and dashes.">
                {(p) => (
                    <Input {...p} value={slug} onChange={(e) => setSlug(e.target.value)} required spellCheck={false} autoComplete="off" />
                )}
            </Field>
            <FieldError message={create.error ? errorMessage(create.error) : null} />
            <div className="flex flex-wrap items-center justify-end gap-2">
                {actions}
                <Button type="submit" disabled={create.isPending || !slug.trim()}>
                    Create organisation
                </Button>
            </div>
        </form>
    );
}

function CreateOrganisation({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
    const navigate = useNavigate();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create an organisation</DialogTitle>
                    <DialogDescription>A workspace to share with others. You'll be its owner; setting it up comes next.</DialogDescription>
                </DialogHeader>
                <CreateOrganisationForm
                    onCreated={async (w) => {
                        onOpenChange(false);
                        await navigate({ to: "/w/$ws", params: { ws: w.slug } });
                        openSetup({ kind: "workspace", ws: w.slug });
                    }}
                    actions={
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                    }
                />
            </DialogContent>
        </Dialog>
    );
}

export function ProjectPicker({ current }: { current: string | undefined }) {
    const me = useMe();
    const { ws, can } = useWorkspace();
    const { isMobile } = useSidebar();
    const projects = useQuery(projectsQuery(ws));
    const list = projects.data ?? [];
    if (!list.length) return null;
    const currentName = list.find((p) => p.slug === current)?.name ?? current ?? "Choose a project";
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <PickerButton
                            icon={<FolderGit2 />}
                            label="Project"
                            value={currentName}
                            badge={isExample(me, ws, current) ? <ExampleBadge className="h-4 px-1 text-[0.65rem]" /> : undefined}
                        />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-60" align="start" side={isMobile ? "bottom" : "right"}>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
                        {list.map((p) => (
                            <DropdownMenuItem key={p.id} asChild>
                                <Link to="/w/$ws/p/$project/overview" params={{ ws, project: p.slug }}>
                                    <span className="flex-1 truncate">{p.name}</span>
                                    {isExample(me, ws, p.slug) && <ExampleBadge />}
                                    <span className="text-xs text-muted-foreground tabular-nums">{p.findings}</span>
                                    {p.slug === current && <Check aria-label="current" />}
                                </Link>
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <Link to="/w/$ws/settings/projects" params={{ ws }}>
                                {can("configure") ? <Plus /> : <FolderGit2 />}
                                {can("configure") ? "New project…" : "All projects"}
                            </Link>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

export function BranchPicker({ project }: { project: string }) {
    const { ws } = useWorkspace();
    const { isMobile } = useSidebar();
    const params = useParams({ strict: false }) as { issueId?: string; taskId?: string };
    const branches = useQuery(branchesQuery(ws, project));
    const search = useLocation({ select: (l) => (l.search as { branch?: string }).branch });
    const data = branches.data;
    const current = search ?? data?.defaultBranch ?? "";
    const items = data?.items ?? [];
    // On an issue or task, switching branch goes back to the list: the item may not exist there.
    const target: string = params.issueId ? "/w/$ws/p/$project/issues" : params.taskId ? "/w/$ws/p/$project/tasks" : ".";

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <PickerButton icon={<GitBranch />} label="Branch" value={current || "…"} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-96 min-w-64 overflow-y-auto" align="start" side={isMobile ? "bottom" : "right"}>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Branches with a report</DropdownMenuLabel>
                        {data && items.length === 0 && (
                            <p className="px-2 py-1.5 text-sm text-muted-foreground">
                                None yet. Upload a report on Branches &amp; reports.
                            </p>
                        )}
                        {items.map((b) => (
                            <DropdownMenuItem key={b.name} asChild>
                                <Link
                                    to={target as never}
                                    params={{ ws, project } as never}
                                    search={
                                        ((prev: Record<string, unknown>) =>
                                            target === "."
                                                ? { ...prev, branch: b.isDefault ? undefined : b.name, page: undefined }
                                                : { branch: b.isDefault ? undefined : b.name }) as never
                                    }
                                >
                                    <span className="grid min-w-0 flex-1">
                                        <span className="truncate font-mono text-xs">{b.name}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {b.isDefault ? "default · " : ""}
                                            {b.unresolved} unresolved · {formatDate(b.uploadedAt)}
                                            {b.github?.onGitHub && !b.github.current
                                                ? ` · out of date${b.github.behind !== null ? `: ${b.github.behind} behind` : ""}`
                                                : ""}
                                        </span>
                                    </span>
                                    {b.name === current && <Check aria-label="current" />}
                                </Link>
                            </DropdownMenuItem>
                        ))}
                        {(data?.github?.notReviewed.length ?? 0) > 0 && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-xs text-muted-foreground">On GitHub, not reviewed yet</DropdownMenuLabel>
                                {data?.github?.notReviewed.slice(0, 20).map((name) => (
                                    <DropdownMenuItem key={name} asChild>
                                        <Link to="/w/$ws/p/$project/branches" params={{ ws, project }}>
                                            <span className="truncate font-mono text-xs">{name}</span>
                                            <span className="ms-auto text-xs text-muted-foreground">review on Branches</span>
                                        </Link>
                                    </DropdownMenuItem>
                                ))}
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
