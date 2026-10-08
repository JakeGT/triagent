// The first-run tutorial: where each person is in it, and their example project. The example lives in the
// person's own personal workspace only, is made with the same services as real data (so every page shows
// it as it would anything else), and never reaches GitHub, a runner or a model: its runs are records of
// reviews that never happened, marked as examples.

import { randomUUID } from "node:crypto";
import { reportMetrics } from "../domain/review-metrics.ts";
import { reviewGaps } from "../domain/review-run.ts";
import { badRequest, notFound } from "../errors.ts";
import { randomId } from "../security.ts";
import {
    type Job,
    type Project,
    type Repos,
    type ReviewRecord,
    TUTORIAL_STATUSES,
    type TutorialState,
    type TutorialStatus,
    type User,
    type Workspace,
} from "../store/types.ts";
import type { Actor, Core } from "./core.ts";
import type { History } from "./history.ts";
import type { Projects } from "./projects.ts";
import type { Reports } from "./reports.ts";
import type { Triage } from "./triage.ts";
import {
    BRANCH_REPORT,
    EXAMPLE_BRANCH,
    EXAMPLE_ISSUE_PATH,
    EXAMPLE_MODEL,
    EXAMPLE_NAME,
    EXAMPLE_PEOPLE,
    EXAMPLE_SLUG,
    MAIN_REPORT,
    PARTIAL_WARNINGS,
} from "./tutorial-example.ts";

/** More than the tutorial has steps, so a client can't store nonsense. */
const MAX_STEP = 50;
const DAY = 86_400_000;

export interface ExampleProject {
    workspace: string;
    project: string;
    name: string;
    /** The finding the tour opens. */
    issue: string | null;
}

export interface TutorialView {
    status: TutorialStatus;
    step: number;
    example: ExampleProject | null;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

export class Tutorial {
    private readonly core: Core;
    private readonly projects: Projects;
    private readonly reports: Reports;
    private readonly triage: Triage;
    private readonly history: History;

    constructor(core: Core, projects: Projects, reports: Reports, triage: Triage, history: History) {
        this.core = core;
        this.projects = projects;
        this.reports = reports;
        this.triage = triage;
        this.history = history;
    }

    /** The person's own personal workspace: the only place the example is ever made. */
    private async personal(tx: Repos, userId: string): Promise<Workspace> {
        for (const m of await tx.memberships.forUser(userId)) {
            const w = await tx.workspaces.get(m.workspaceId);
            if (w?.kind === "personal" && m.role === "owner") return w;
        }
        throw notFound("You have no personal workspace to put the example in.");
    }

    /** Their example project, if it still exists where it was made. */
    private async example(tx: Repos, user: User): Promise<{ workspace: Workspace; project: Project } | null> {
        if (!user.tutorial.exampleProject) return null;
        const workspace = await this.personal(tx, user.id).catch(() => null);
        const project = workspace ? await tx.projects.bySlug(workspace.id, user.tutorial.exampleProject) : null;
        return workspace && project ? { workspace, project } : null;
    }

    private async view(tx: Repos, user: User): Promise<TutorialView> {
        const found = await this.example(tx, user);
        let example: ExampleProject | null = null;
        if (found) {
            const main = await this.reports.view(tx, found.project, found.project.defaultBranch);
            example = {
                workspace: found.workspace.slug,
                project: found.project.slug,
                name: found.project.name,
                issue: main.review.issues.find((x) => x.path === EXAMPLE_ISSUE_PATH)?.id ?? null,
            };
        }
        return { status: user.tutorial.status, step: user.tutorial.step, example };
    }

    private async user(tx: Repos, userId: string): Promise<User> {
        const user = await tx.users.get(userId);
        if (!user) throw notFound("No such account.");
        return user;
    }

    private async save(tx: Repos, user: User, tutorial: TutorialState): Promise<User> {
        const next = { ...user, tutorial };
        await tx.users.put(next);
        return next;
    }

    async get(userId: string): Promise<TutorialView> {
        return this.core.store.transaction(async (tx) => this.view(tx, await this.user(tx, userId)));
    }

    /** Move through the tutorial: start it, remember the step, finish or skip it, or start again. */
    async update(userId: string, input: { status?: unknown; step?: unknown }): Promise<TutorialView> {
        const patch: Partial<TutorialState> = {};
        if (input.status !== undefined) {
            if (!TUTORIAL_STATUSES.includes(input.status as TutorialStatus))
                throw badRequest(`status must be one of ${TUTORIAL_STATUSES.join(", ")}.`);
            patch.status = input.status as TutorialStatus;
        }
        if (input.step !== undefined) {
            if (!Number.isInteger(input.step) || (input.step as number) < 0 || (input.step as number) > MAX_STEP)
                throw badRequest(`step must be a whole number from 0 to ${MAX_STEP}.`);
            patch.step = input.step as number;
        }
        if (!Object.keys(patch).length) throw badRequest("Send a status, a step, or both.");
        return this.core.store.transaction(async (tx) => {
            const user = await this.user(tx, userId);
            return this.view(tx, await this.save(tx, user, { ...user.tutorial, ...patch }));
        });
    }

    /** Make the example project in the person's personal workspace, or return the one they have. */
    async createExample(actor: Actor & { userId: string }): Promise<TutorialView> {
        // One transaction: the example appears whole or not at all, and two requests at once make one.
        return this.core.store.transaction(async (tx) => {
            const user = await this.user(tx, actor.userId);
            if (await this.example(tx, user)) return this.view(tx, user);
            const workspace = await this.personal(tx, user.id);
            let slug = EXAMPLE_SLUG;
            for (let n = 2; await tx.projects.bySlug(workspace.id, slug); n++) slug = `${EXAMPLE_SLUG}-${n}`;
            await this.projects.create(actor, workspace, { slug, name: EXAMPLE_NAME, defaultBranch: "main" });
            const project = (await tx.projects.bySlug(workspace.id, slug)) as Project;
            await this.fill(tx, project);
            return this.view(tx, await this.save(tx, user, { ...user.tutorial, exampleProject: slug }));
        });
    }

    /** Remove the example project, and its reviews from the analytics. Nothing else is touched. */
    async removeExample(actor: Actor & { userId: string }): Promise<TutorialView> {
        return this.core.store.transaction(async (tx) => {
            const user = await this.user(tx, actor.userId);
            const found = await this.example(tx, user);
            if (found) {
                await this.projects.delete(actor, found.project, found.project.slug);
                await tx.reviewHistory.removeProject(found.workspace.id, found.project.id);
            }
            return this.view(tx, await this.save(tx, user, { ...user.tutorial, exampleProject: null }));
        });
    }

    /** Reports, triage, review history and finished runs, as made-up people and reviews would leave them. */
    private async fill(tx: Repos, project: Project): Promise<void> {
        const ci: Actor = { name: EXAMPLE_PEOPLE.ci, userId: null, via: "token" };
        const reviewer: Actor = { name: "Open Code Review (example)", userId: null, via: "github" };
        const sam: Actor = { name: EXAMPLE_PEOPLE.sam, userId: null, via: "web" };
        const priya: Actor = { name: EXAMPLE_PEOPLE.priya, userId: null, via: "web" };

        // The default branch, uploaded from CI (recorded in the review history as an upload).
        await this.reports.upload(ci, project, { branch: "main", fileName: "code_review.json", report: MAIN_REPORT, confirm: true });
        const main = await this.reports.view(tx, project, "main");
        const id = (path: string, n = 0) => main.review.issues.filter((x) => x.path === path)[n]?.id as string;
        const ref = { project, branch: "main" };
        const triage = (who: Actor, path: string, body: Record<string, unknown>) => this.triage.updateIssue(who, ref, id(path), body);

        await triage(sam, "src/api/search.ts", {
            status: "in_progress",
            assignee: EXAMPLE_PEOPLE.sam,
            note: "Switching every query in the search API to parameters. The product filters have the same problem.",
        });
        await triage(priya, "src/api/search.ts", { note: "Worth a test that searches for `'; DROP TABLE products; --` too." });
        await triage(priya, "src/checkout/payment.ts", { status: "resolved", note: "Fixed: we log the payment reference now." });
        await triage(sam, "src/config.ts", { status: "wont_fix", note: "The mobile app still reads this flag from the shared config." });
        await triage(priya, EXAMPLE_ISSUE_PATH, {
            severity: "high",
            note: "Rated high: these emails go to every customer, and some mail apps show the HTML.",
        });
        await triage(sam, "src/checkout/totals.ts", { duplicateOf: id("src/lib/money.ts") });
        await triage(sam, "src/checkout/CheckoutForm.tsx", { needsDiscussion: true });
        await triage(priya, "src/lib/money.ts", { assignee: EXAMPLE_PEOPLE.priya });

        // The pull request's branch, as a review run on the server would upload it (it records its own history).
        await this.reports.upload(reviewer, project, {
            branch: EXAMPLE_BRANCH,
            fileName: "PR #12",
            scope: "diff",
            report: BRANCH_REPORT,
            confirm: true,
        });

        // Two finished runs, marked as examples: a pull request reviewed two days ago, and a full scan that
        // only partly finished last week. Neither ran: no runner, GitHub or model was involved.
        await this.exampleRun(tx, project, {
            kind: "pr",
            title: "Example: PR #12: Redesign the checkout",
            branch: EXAMPLE_BRANCH,
            gitRef: EXAMPLE_BRANCH,
            baseRef: "main",
            pr: { number: 12, title: "Redesign the checkout", url: null, headRef: EXAMPLE_BRANCH, author: "sam-lee" },
            agoMs: 2 * DAY,
            seconds: 125,
            report: BRANCH_REPORT,
            status: "done",
        });
        await this.exampleRun(tx, project, {
            kind: "full",
            title: "Example: Full scan of main",
            branch: "main",
            gitRef: "main",
            baseRef: null,
            pr: null,
            agoMs: 6 * DAY,
            seconds: 512,
            report: { ...MAIN_REPORT, status: "partial", warnings: PARTIAL_WARNINGS },
            status: "partial",
        });
    }

    private async exampleRun(
        tx: Repos,
        project: Project,
        spec: {
            kind: Job["kind"];
            title: string;
            branch: string;
            gitRef: string;
            baseRef: string | null;
            pr: Job["pr"];
            agoMs: number;
            seconds: number;
            report: typeof MAIN_REPORT;
            status: "done" | "partial";
        },
    ): Promise<void> {
        const finishedAt = iso(spec.agoMs);
        const startedAt = iso(spec.agoMs + spec.seconds * 1000);
        const queuedAt = iso(spec.agoMs + spec.seconds * 1000 + 40_000);
        const m = reportMetrics(spec.report);
        const gaps = spec.status === "partial" ? reviewGaps(spec.report) : null;
        const job: Job = {
            id: randomId(),
            workspaceId: project.workspaceId,
            projectId: project.id,
            kind: spec.kind,
            dedupeKey: `example:${randomUUID()}`,
            title: spec.title,
            branch: spec.branch,
            gitRef: spec.gitRef,
            baseRef: spec.baseRef,
            headSha: null,
            baseSha: null,
            pr: spec.pr,
            requestedBy: { name: EXAMPLE_PEOPLE.sam, userId: null, tokenId: null },
            source: "person",
            status: spec.status,
            queuedAt,
            startedAt,
            finishedAt,
            runnerId: null,
            leaseExpiresAt: null,
            cancelRequested: null,
            progress: { phase: "finished", example: true },
            result: {
                total: m.findings.total,
                bySeverity: m.findings.bySeverity,
                gaps,
                counts: null,
                tokens: m.tokens,
                filesReviewed: m.files?.reviewed ?? null,
                ocrVersion: m.ocrVersion,
                seconds: spec.seconds,
                example: true,
            },
            error: null,
            model: { provider: "openrouter", model: EXAMPLE_MODEL, keySource: "workspace" },
            credentials: null,
            repository: null,
            logLines: 0,
            logDropped: 0,
        };
        await tx.jobs.put(job);
        await tx.jobs.appendLog(
            job.id,
            [
                "This is an example run for the tutorial: nothing was fetched or reviewed, and no model was used.",
                `A real run's log shows Open Code Review at work: fetching the code, planning, reviewing ${m.files?.reviewed ?? "the"} files and summarising.`,
                ...(gaps ? [gaps.note] : []),
                `Finished: ${m.findings.total} findings.`,
            ].map((line) => ({ at: finishedAt, line })),
            64_000,
        );
        const record: Omit<ReviewRecord, "id"> = {
            workspaceId: project.workspaceId,
            projectId: project.id,
            branch: spec.branch,
            at: finishedAt,
            source: "run",
            kind: spec.kind,
            status: spec.status,
            model: EXAMPLE_MODEL,
            provider: "openrouter",
            keySource: "workspace",
            tokens: m.tokens,
            details: {
                ...(spec.pr ? { prNumber: spec.pr.number } : {}),
                commit: null,
                requestedBy: EXAMPLE_PEOPLE.sam,
                ocrVersion: m.ocrVersion,
                queuedAt,
                startedAt,
                queueSeconds: 40,
                runSeconds: spec.seconds,
                findings: m.findings,
                files: { ...(m.files ?? {}), failedGroups: gaps?.groups ?? 0 },
                ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
                ...(m.llm ? { llm: m.llm } : {}),
                error: null,
            },
        };
        await this.history.record(tx, record);
    }
}
