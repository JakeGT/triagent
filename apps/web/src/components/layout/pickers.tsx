// Workspace, project and branch pickers at the top of the rail. Each is a menu of links: choosing one
// is an explicit action, and nothing happens on focus or arrowing through the options.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown, FolderGit2, GitBranch, Plus, User } from "lucide-react";
import { useState } from "react";
import { Field, FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { api, errorMessage, paths } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { branchesQuery, keys, projectsQuery } from "@/lib/queries";
import { useMe, useWorkspace } from "@/lib/session";
import type { WorkspaceSummary } from "@/lib/types";

function PickerButton({
    icon,
    label,
    value,
    ...props
}: { icon: React.ReactNode; label: string; value: string } & React.ComponentProps<typeof SidebarMenuButton>) {
    return (
        <SidebarMenuButton
            {...props}
            size="lg"
            className="h-11 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            tooltip={`${label}: ${value}`}
        >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background [&>svg]:size-4">{icon}</span>
            <span className="grid min-w-0 flex-1 text-start leading-tight">
                <span className="text-[0.7rem] text-muted-foreground">{label}</span>
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

function CreateOrganisation({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [slug, setSlug] = useState("");
    const [name, setName] = useState("");
    const create = useMutation({
        mutationFn: () => api.post<WorkspaceSummary>(paths.workspaces, { slug: slug.trim().toLowerCase(), name: name.trim() || undefined }),
        onSuccess: async (w) => {
            await queryClient.invalidateQueries({ queryKey: keys.me });
            onOpenChange(false);
            setSlug("");
            setName("");
            await navigate({ to: "/w/$ws", params: { ws: w.slug } });
        },
    });
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <form
                    className="grid gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        create.mutate();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Create an organisation</DialogTitle>
                        <DialogDescription>
                            A workspace to share with others. You'll be its owner and can add members in Settings.
                        </DialogDescription>
                    </DialogHeader>
                    <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                    <Field label="Id" hint="Used in addresses: lower-case letters, numbers and dashes.">
                        {(p) => (
                            <Input
                                {...p}
                                value={slug}
                                onChange={(e) => setSlug(e.target.value)}
                                required
                                spellCheck={false}
                                autoComplete="off"
                            />
                        )}
                    </Field>
                    <FieldError message={create.error ? errorMessage(create.error) : null} />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={create.isPending || !slug.trim()}>
                            Create organisation
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ProjectPicker({ current }: { current: string | undefined }) {
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
                        <PickerButton icon={<FolderGit2 />} label="Project" value={currentName} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-60" align="start" side={isMobile ? "bottom" : "right"}>
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
                        {list.map((p) => (
                            <DropdownMenuItem key={p.id} asChild>
                                <Link to="/w/$ws/p/$project/overview" params={{ ws, project: p.slug }}>
                                    <span className="flex-1 truncate">{p.name}</span>
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
                        {items.length === 0 && (
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
                                        </span>
                                    </span>
                                    {b.name === current && <Check aria-label="current" />}
                                </Link>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
