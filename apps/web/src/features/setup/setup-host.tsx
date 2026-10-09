// Shows the guided setup that's open (setup-store.ts), once the page is on its workspace or project, and
// opens one by itself in two cases: account setup, the first time someone signs in (after the tutorial,
// which comes first), and a project's setup coming back from installing the GitHub App (?setup=project).
// Finish setup in the top bar opens one while anything required is left.

import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { allowanceQuery } from "@/lib/insights-queries";
import { githubQuery, projectQuery, projectsQuery, reviewModelQuery } from "@/lib/queries";
import { ProjectContext, type ProjectContextValue, useMe, useWorkspace } from "@/lib/session";
import { isExample, tutorialApi } from "@/lib/tutorial";
import { useAccountFlow, useProjectFlow, useWorkspaceFlow } from "./flows";
import { SetupDialog } from "./setup-dialog";
import { closeSetup, type Opened, openSetup, useOpenSetup } from "./setup-store";

function AccountSetup({ step }: { step?: string }) {
    const flow = useAccountFlow();
    // Account setup is all choices with good defaults: closing it counts as done, so it doesn't come back.
    return (
        <SetupDialog
            flow={flow}
            startAt={step}
            onClose={() => {
                closeSetup();
                void tutorialApi.update({ setup: "done" }).catch(() => {});
            }}
        />
    );
}

function WorkspaceSetup({ step }: { step?: string }) {
    return <SetupDialog flow={useWorkspaceFlow()} startAt={step} onClose={closeSetup} />;
}

function ProjectSetupDialog({ step }: { step?: string }) {
    return <SetupDialog flow={useProjectFlow()} startAt={step} onClose={closeSetup} />;
}

/** The project's setup, with the project loaded for its forms (the setup sits above the project's pages). */
function ProjectSetup({ ws, project, step }: { ws: string; project: string; step?: string }) {
    const query = useQuery(projectQuery(ws, project));
    const value = useMemo<ProjectContextValue | null>(
        () => (query.data ? { ws, slug: project, project: query.data, branch: query.data.defaultBranch, branchParam: undefined } : null),
        [ws, project, query.data],
    );
    if (!value) return null;
    return (
        <ProjectContext value={value}>
            <ProjectSetupDialog step={step} />
        </ProjectContext>
    );
}

export function SetupHost() {
    const opened = useOpenSetup();
    const me = useMe();
    const { ws, can } = useWorkspace();
    const { project } = useParams({ strict: false }) as { project?: string };
    const searchStr = useLocation({ select: (l) => l.searchStr });

    // Back from installing the GitHub App, started in the project's setup.
    useEffect(() => {
        if (project && new URLSearchParams(searchStr).get("setup") === "project") openSetup({ kind: "project", ws, project }, "github");
    }, [searchStr, ws, project]);

    // The first sign-in: account setup, once the tutorial is out of the way.
    const offered = useRef(false);
    const t = me.tutorial;
    useEffect(() => {
        if (offered.current || opened || me.mustChangePassword || t.setup !== "pending") return;
        if (t.status !== "completed" && t.status !== "dismissed") return;
        offered.current = true;
        openSetup({ kind: "account" });
    }, [opened, me.mustChangePassword, t.setup, t.status]);

    if (!opened) return null;
    if (opened.kind === "account") return <AccountSetup step={opened.step} />;
    // A workspace's or project's setup waits for its page (creating one goes there first).
    if (opened.ws !== ws || !can("configure")) return null;
    if (opened.kind === "workspace") return <WorkspaceSetup step={opened.step} />;
    return <ProjectSetup ws={ws} project={opened.project} step={opened.step} />;
}

/**
 * Finish setup, in the top bar: while the workspace (or the project in view) still lacks something reviews
 * need, for people who can set it up. It opens the setup at the first thing left.
 */
export function FinishSetupButton() {
    const me = useMe();
    const { ws, can } = useWorkspace();
    const { project } = useParams({ strict: false }) as { project?: string };
    const allowed = can("configure");
    const inProject = Boolean(project && !isExample(me, ws, project));
    const model = useQuery({ ...reviewModelQuery(ws), enabled: allowed });
    const allowance = useQuery({ ...allowanceQuery(ws), enabled: allowed });
    const projects = useQuery({ ...projectsQuery(ws), enabled: allowed });
    const projectData = useQuery({ ...projectQuery(ws, project ?? ""), enabled: allowed && inProject });
    const github = useQuery({ ...githubQuery(ws, project ?? ""), enabled: allowed && inProject });
    if (!allowed || !model.data || !projects.data) return null;

    const left: { what: string; open: Opened }[] = [];
    if (inProject && project) {
        if (projectData.data && !projectData.data.repoUrl)
            left.push({ what: "the repository", open: { kind: "project", ws, project, step: "repository" } });
        if (github.data && github.data.mode === "none")
            left.push({ what: "a GitHub connection", open: { kind: "project", ws, project, step: "github" } });
    }
    if (!model.data.ready && !allowance.data?.now.ready)
        left.push({ what: "a review model key", open: { kind: "workspace", ws, step: "model" } });
    if (!projects.data.some((p) => !isExample(me, ws, p.slug)))
        left.push({ what: "a project", open: { kind: "workspace", ws, step: "project" } });
    const first = left[0];
    if (!first) return null;
    const { step, ...target } = first.open;
    return (
        <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => openSetup(target, step)}
            title={`Still needed: ${left.map((l) => l.what).join(", ")}.`}
            data-testid="finish-setup"
        >
            <ListChecks /> Finish setup
            <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                {left.length}
                <span className="sr-only"> {left.length === 1 ? "thing" : "things"} left</span>
            </Badge>
        </Button>
    );
}
