// The tutorial's steps: where each goes in the example project, which part of the page it's about
// (data-tour="…" on that element; e2e/tutorial.spec.ts fails if one goes missing), and what it says.

import type { ReactNode } from "react";

export interface Example {
    workspace: string;
    project: string;
    name: string;
    issue: string | null;
}

export interface StepContext {
    example: Example;
    isInstanceAdmin: boolean;
}

export interface Step {
    id: string;
    title: string;
    /** The data-tour value of the part of the page it's about. */
    anchor?: string;
    /** Where to go first: a path in the app. */
    path?: (e: Example) => string;
    body: (c: StepContext) => ReactNode;
    /** A "try it" step: Next waits until the person has done it (or skips it). */
    tryIt?: "resolve-issue";
}

const project = (e: Example) => `/w/${encodeURIComponent(e.workspace)}/p/${encodeURIComponent(e.project)}`;

export const STEPS: readonly Step[] = [
    {
        id: "welcome",
        title: "Welcome to Triagent",
        path: (e) => `${project(e)}/overview`,
        body: ({ example }) => (
            <>
                <p>
                    Triagent runs Open Code Review on your pull requests and gives people and AI agents one place to triage what it finds.
                </p>
                <p>
                    This short tour uses <strong>{example.name}</strong>, an example project in your personal workspace with made-up
                    findings. Change anything you like: it's yours, and you can remove it at the end.
                </p>
            </>
        ),
    },
    {
        id: "pickers",
        title: "Workspace, project and branch",
        anchor: "pickers",
        path: (e) => `${project(e)}/overview`,
        body: () => (
            <>
                <p>
                    The <strong>workspace</strong> holds projects: everyone has a personal one, and organisations are shared with others.
                    Each <strong>project</strong> is one codebase, and each <strong>branch</strong> has its own report and triage.
                </p>
                <p>The example project is chosen now, and marked Example wherever it appears.</p>
            </>
        ),
    },
    {
        id: "overview",
        title: "Overview",
        anchor: "overview-tiles",
        path: (e) => `${project(e)}/overview`,
        body: () => (
            <p>
                A branch at a glance: how many issues there are and how many are dealt with, then the reviewer's themes, the files with the
                most findings (hotspots) and what changed lately. Every number is a link to the issues behind it.
            </p>
        ),
    },
    {
        id: "issues",
        title: "Issues",
        anchor: "issue-filters",
        path: (e) => `${project(e)}/issues`,
        body: () => (
            <>
                <p>Every finding, most urgent first. Filter by severity, status and category, or search text, files and ids.</p>
                <p>
                    Keyboard: <kbd>j</kbd> and <kbd>k</kbd> move through the list, <kbd>x</kbd> selects, <kbd>1</kbd>–<kbd>4</kbd> set the
                    status and <kbd>/</kbd> searches. Select several issues to change them all at once.
                </p>
            </>
        ),
    },
    {
        id: "issue",
        title: "One issue",
        anchor: "issue-finding",
        path: (e) => `${project(e)}/issues/${encodeURIComponent(e.issue ?? "")}`,
        body: () => (
            <p>
                What the reviewer found, and the code it's about: <strong>Diff</strong> shows the current code against the reviewer's
                suggested fix, and the other tabs show each on its own.
            </p>
        ),
    },
    {
        id: "triage",
        title: "Triage",
        anchor: "triage",
        path: (e) => `${project(e)}/issues/${encodeURIComponent(e.issue ?? "")}`,
        body: () => (
            <>
                <p>
                    Set the <strong>status</strong>, <strong>assign it to yourself</strong>, or <strong>correct the rating</strong> when the
                    reviewer got it wrong: this one says “High, was low”, so everyone can see the change.
                </p>
                <p>
                    Mark a <strong>duplicate</strong> of another issue, flag it as <strong>needing discussion</strong>, and leave{" "}
                    <strong>notes</strong> below for people and agents.
                </p>
            </>
        ),
    },
    {
        id: "try-it",
        title: "Try it: mark this issue resolved",
        anchor: "issue-status",
        tryIt: "resolve-issue",
        path: (e) => `${project(e)}/issues/${encodeURIComponent(e.issue ?? "")}`,
        body: () => (
            <p>
                Choose <strong>Resolved</strong> to say it's fixed (or press <kbd>3</kbd>). The tour carries on once it's saved; a newer
                report that still finds it reopens it.
            </p>
        ),
    },
    {
        id: "tasks",
        title: "Tasks",
        anchor: "tasks-list",
        path: (e) => `${project(e)}/tasks`,
        body: () => (
            <p>
                The reviewer's summary, turned into tasks. Each is linked to the issues in the files it names, so it shows how far along it
                is. The summary itself is on the second tab.
            </p>
        ),
    },
    {
        id: "branches",
        title: "Branches & reports",
        anchor: "branches-table",
        path: (e) => `${project(e)}/branches`,
        body: () => (
            <p>
                Each branch with a report. Upload a report from Open Code Review here (you see what it would change before you confirm), or
                from CI. Findings still in a new report keep their triage, and every replaced report stays in the branch's history.
            </p>
        ),
    },
    {
        id: "compare",
        title: "Compare",
        anchor: "compare-summary",
        path: (e) => `${project(e)}/compare?base=main&head=${encodeURIComponent("feature/checkout-redesign")}`,
        body: () => (
            <p>
                What a branch adds compared with another, and which findings it no longer has. Here, the checkout redesign brings a new
                critical bug that main doesn't have.
            </p>
        ),
    },
    {
        id: "runs",
        title: "Runs and pull requests",
        anchor: "runs-recent",
        path: (e) => `${project(e)}/runs`,
        body: () => (
            <>
                <p>
                    With the project connected to GitHub, Triagent reviews each pull request, leaves one comment on it and sets a commit
                    status. You can also start a review of a branch here. Runs shows what's running, queued and finished, with each run's
                    log; Pull requests shows what's open on GitHub.
                </p>
                <p>These two runs are examples: nothing ran, and no model was used.</p>
            </>
        ),
    },
    {
        id: "analytics",
        title: "Analytics",
        anchor: "analytics-filters",
        path: (e) => `/w/${encodeURIComponent(e.workspace)}/analytics?project=${encodeURIComponent(e.project)}`,
        body: () => (
            <p>
                Reviews, findings and triage over time, for one project or all of them: how long reviews take, what they cost, how quickly
                findings are dealt with, and by people or agents.
            </p>
        ),
    },
    {
        id: "activity",
        title: "Activity",
        anchor: "activity-list",
        path: (e) => `${project(e)}/activity`,
        body: () => <p>Every change to issues, tasks, reports and branches, newest first, and who made it: a person, an agent or CI.</p>,
    },
    {
        id: "agents",
        title: "Agents & API",
        anchor: "agents-mcp",
        path: (e) => `/w/${encodeURIComponent(e.workspace)}/agents?project=${encodeURIComponent(e.project)}`,
        body: () => (
            <p>
                Connect Claude Code, Codex or OpenCode over <strong>MCP</strong> with an API token, so they can claim an issue, fix it and
                mark it resolved with a note. The <strong>skill</strong> teaches them the workflow, and a step in <strong>CI</strong>{" "}
                uploads each new report.
            </p>
        ),
    },
    {
        id: "settings",
        title: "Settings",
        anchor: "settings-nav",
        path: (e) => `/w/${encodeURIComponent(e.workspace)}/settings/review-model`,
        body: ({ isInstanceAdmin }) => (
            <>
                <p>
                    Connect a project to GitHub (Project → GitHub) through the <strong>GitHub App</strong> or a fine-grained token, and
                    choose the model reviews use under <strong>Review model & keys</strong>: Anthropic, OpenAI, Google Gemini, Mistral,
                    OpenRouter, Amazon Bedrock, Azure OpenAI, your own OpenAI-compatible server and more, each with its own key.
                </p>
                <p>
                    <strong>Members</strong> and invites decide who can use a workspace, and API tokens let agents in.
                    {isInstanceAdmin
                        ? " As an instance administrator you also look after accounts, the GitHub App and the instance's model key."
                        : ""}
                </p>
            </>
        ),
    },
    {
        id: "finish",
        title: "You're ready",
        path: (e) => `${project(e)}/overview`,
        body: () => (
            <>
                <p>Create a project for your own code under Settings → Projects, or upload a report to start.</p>
                <p>
                    Keep the example project to look around some more, or remove it now. You can take this tour again from Settings →
                    Tutorial.
                </p>
            </>
        ),
    },
];
