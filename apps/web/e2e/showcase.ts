// A workspace with something on every page, for screenshots and layout checks: a project on a fake
// GitHub repository, reports on two branches with some triage, a finished review, open pull requests,
// an API token, a model price and a second member.

import { randomBytes } from "node:crypto";
import { type Api, addMember, expect, issuesOf, REPORT, unique } from "./fixtures";

const GITHUB = process.env.E2E_GITHUB_URL as string;

/** Set up the fake GitHub (repositories, pull requests, tokens) the end-to-end server talks to. */
export async function fakeGithub<T = Record<string, unknown>>(what: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GITHUB}/_fake/${what}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`fake ${what}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

export interface Showcase {
    ws: string;
    project: string;
    base: string;
    issueId: string;
    runId: string;
}

export async function seedShowcase(admin: Api, baseURL: string): Promise<Showcase> {
    const ws = unique("show");
    const repo = `acme/${ws}`;
    const project = "web";
    await fakeGithub("git-repo", { fullName: repo, files: { "src/app.ts": "export const app = 1;\n", "README.md": "# Web\n" } });
    const token = `github_pat_${randomBytes(16).toString("hex")}`;
    await fakeGithub("pat", { token, login: "octo", repos: [repo] });
    await admin.post("/api/v1/workspaces", { slug: ws, name: "Acme Engineering" });
    await admin.post(`/api/v1/w/${ws}/projects`, { slug: project, name: "Web shop", repoUrl: `https://github.com/${repo}` });
    const api = `/api/v1/w/${ws}/p/${project}`;
    await admin.put(`${api}/settings/github/token`, { token });
    await admin.put(`/api/v1/w/${ws}/settings/review-model/keys/openrouter`, { key: `sk-or-${randomBytes(12).toString("hex")}` });
    await admin.patch(`/api/v1/w/${ws}/settings/review-model`, { model: "fake/model" });

    await admin.post(`${api}/reports`, { branch: "main", fileName: "code_review.json", report: REPORT });
    await admin.post(`${api}/reports`, {
        branch: "feature/checkout-redesign",
        fileName: "pr-12.json",
        scope: "diff",
        report: { ...REPORT, comments: REPORT.comments.slice(3, 8) },
    });
    const issues = await issuesOf(admin, ws, project);
    const [first, second, third, fourth] = issues;
    await admin.patch(`${api}/issues/${first?.id}?branch=main`, {
        status: "in_progress",
        assignee: "admin",
        note: "Switching to a parameterised query.",
    });
    await admin.patch(`${api}/issues/${second?.id}?branch=main`, { severity: "medium", needsDiscussion: true });
    await admin.patch(`${api}/issues/${third?.id}?branch=main`, { status: "resolved" });
    await admin.patch(`${api}/issues/${fourth?.id}?branch=main`, { status: "wont_fix", note: "Covered by the gateway." });

    for (const [n, branch, title] of [
        [12, "checkout-redesign", "Redesign the checkout"],
        [14, "export-csv", "Export orders as CSV"],
    ] as const) {
        await fakeGithub("commit", {
            fullName: repo,
            branch,
            from: "main",
            message: title,
            files: { [`src/${branch}.ts`]: `// ${title}\n` },
        });
        await fakeGithub("pull", { fullName: repo, number: n, headRef: branch, title });
    }
    await admin.post(`${api}/pull-requests/check`);
    const run = await admin.post(`${api}/reviews`, { kind: "pr", number: 12 });
    await expect.poll(async () => (await admin.get(`/api/v1/w/${ws}/runs/${run.id}`)).status, { timeout: 20_000 }).toBe("done");

    await admin.post(`/api/v1/w/${ws}/settings/tokens`, { name: "Claude on Sam laptop", scope: "full" });
    await admin.post(`/api/v1/w/${ws}/settings/tokens`, { name: "CI uploads", scope: "upload", expiresInDays: 90 });
    await admin.put(`/api/v1/w/${ws}/settings/model-prices`, {
        model: "anthropic/claude-sonnet-4.5",
        input: 3,
        output: 15,
        cacheRead: 0.3,
    });
    const member = await addMember(admin, baseURL, ws, "editor");
    await member.api.ctx.dispose();
    return { ws, project, base: `/w/${ws}/p/${project}`, issueId: first?.id as string, runId: run.id as string };
}
