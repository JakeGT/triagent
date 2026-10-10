// The front door, for everyone: what Triagent is, told as a page rather than a dashboard. It follows the
// reader's theme and uses the app's own surfaces, type and marks; its only pictures are pieces of the
// product: a review played out beside the headline, a miniature of the Issues page to try, how three
// reviews become one list, and an agent's terminal. Everything shown is made up and stays in the browser;
// the page asks the server only whether you're signed in, to offer the right button.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { SeverityMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/context/theme-provider";
import { meQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ReviewStage } from "./review-stage";
import { agreement, FINDINGS, MODELS } from "./sample";
import { TryIt } from "./try-it";

/** Every model's findings before merging: one for each model that found each finding. */
const RAW = FINDINGS.reduce((n, f) => n + f.foundBy.length, 0);

/** Some of the seventeen, not all of them: the line that lists them says so. */
const PROVIDERS = [
    "Anthropic",
    "OpenAI",
    "Google Gemini",
    "Mistral",
    "xAI",
    "DeepSeek",
    "Amazon Bedrock",
    "Azure",
    "OpenRouter",
    "your own server",
];

/** The one column every section sits on. */
const COLUMN = "mx-auto max-w-6xl px-5 sm:px-8";
/** Prose: a size to read at, and never a line too long to follow. */
const PROSE = "max-w-[65ch] text-base leading-normal text-pretty";
const LINK = "text-primary underline underline-offset-2 hover:no-underline";

/** A section's heading and, under it, what the section is about. */
function SectionHeading({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
    return (
        <div className="grid gap-3">
            <h2 id={id} className="max-w-[28ch] scroll-mt-20 text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
                {title}
            </h2>
            {children && <p className={cn(PROSE, "text-muted-foreground")}>{children}</p>}
        </div>
    );
}

/** Says what choosing it gives you. On a phone there's room for the icon only. */
function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const dark = resolvedTheme === "dark";
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-sm:size-9 max-sm:border-transparent max-sm:bg-transparent max-sm:px-0 max-sm:shadow-none"
            aria-label={dark ? "Light theme" : "Dark theme"}
            onClick={() => setTheme(dark ? "light" : "dark")}
        >
            {dark ? <Sun /> : <Moon />}
            <span className="max-sm:hidden">{dark ? "Light" : "Dark"}</span>
        </Button>
    );
}

function Points({ children }: { children: ReactNode }) {
    return <ul className={cn(PROSE, "grid list-disc gap-2 ps-5 marker:text-muted-foreground")}>{children}</ul>;
}

const STEPS: { title: string; text: string }[] = [
    {
        title: "Connect a repository",
        text: "Install the GitHub App on it, or give Triagent a token for that one repository.",
    },
    {
        title: "Choose your models",
        text: "Bring keys for the providers you use, keep a few favourite models, and pick a default.",
    },
    {
        title: "Reviews run",
        text: "Open Code Review reads each pull request with every model you chose, on a runner of your own.",
    },
    {
        title: "Work one list",
        text: "Findings land in one place. People and agents claim them, fix them and say what they did.",
    },
];

const REASONS: { title: string; text: string }[] = [
    {
        title: "Your keys, your models",
        text: "Seventeen providers, from Anthropic and OpenAI to Bedrock, Azure and your own server. Keys are encrypted, write-only, and never shown again.",
    },
    {
        title: "A runner with nothing to steal",
        text: "Reviews run in a separate process with no database, an empty home directory and credentials made for that one job, revoked when it ends.",
    },
    {
        title: "A pull request can't review itself",
        text: "Review rules, ignore files and attributes come from the base branch, so a change can't rewrite how it's reviewed or hide its own files.",
    },
    {
        title: "Tokens that can't outrank you",
        text: "An agent's token acts for a member and never has more access than they do. No token can read secrets or manage people.",
    },
    {
        title: "Sign in your way",
        text: "Local accounts, or your identity provider over OpenID Connect. Invite-only until you decide otherwise.",
    },
    {
        title: "Know what it costs",
        text: "Tokens and cost per review and per finding, how long reviews take, and how quickly findings get fixed, by model.",
    },
];

/** The idea in four figures, each leading to the next, taken from the sample review. */
function InNumbers() {
    const steps: { n: number; label: string; note: string }[] = [
        { n: MODELS.length, label: "models", note: "review the same pull request" },
        { n: RAW, label: "findings", note: "between them, many said twice" },
        { n: FINDINGS.length, label: "to triage", note: "once the same ones are merged" },
        { n: 1, label: "list", note: "for your team and your agents" },
    ];
    return (
        <div className="grid gap-4">
            {/* One under another on a phone, where the order needs no arrows; side by side from there up. */}
            <ol className="grid gap-x-12 gap-y-5 md:grid-cols-4">
                {steps.map((s, i) => (
                    <li key={s.label} className="relative grid content-start gap-0.5">
                        {i > 0 && (
                            <ArrowRight
                                className="absolute -start-9 top-2.5 size-5 text-muted-foreground max-md:hidden"
                                aria-hidden="true"
                            />
                        )}
                        <p className="flex items-baseline gap-2">
                            <span className="font-mono text-3xl leading-none font-semibold tabular-nums">{s.n}</span>
                            <span className="text-base font-semibold">{s.label}</span>
                        </p>
                        <p className="text-base leading-normal text-muted-foreground">{s.note}</p>
                    </li>
                ))}
            </ol>
            <p className="text-[0.9375rem] text-muted-foreground">
                These are the figures of the made-up review in{" "}
                <a href="#try" className={LINK}>
                    Try it
                </a>
                , below, not a measurement.
            </p>
        </div>
    );
}

/** Three reviewers' findings as one list: who found each, then how much they agreed. */
function MergePicture() {
    const rows = agreement(FINDINGS);
    const shown = FINDINGS.slice(0, 3);
    return (
        <figure className="grid min-w-0 gap-5 rounded-lg border bg-card p-5 sm:p-6">
            <figcaption className="text-base font-semibold">Found by several, listed once</figcaption>
            <ul className="grid grid-cols-[minmax(0,1fr)] divide-y border-y">
                {shown.map((f) => (
                    <li key={f.id} className="flex min-w-0 items-center gap-3 py-2.5">
                        <SeverityMark severity={f.severity} className="shrink-0 text-xs" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.title}</span>
                        <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                            {MODELS.map((m) => (
                                <span
                                    key={m}
                                    className={cn(
                                        "size-2.5 rounded-full",
                                        f.foundBy.includes(m) ? "bg-primary" : "border border-foreground/30",
                                    )}
                                />
                            ))}
                        </span>
                        <span className="sr-only">
                            Found by {f.foundBy.length} of {MODELS.length} models
                        </span>
                    </li>
                ))}
            </ul>
            <div className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                    The sample review: {FINDINGS.length} findings, by how many models found them
                </p>
                {/* A bar of one block for each finding: the counts are small enough to count. */}
                <ul className="grid gap-2">
                    {rows.map((r) => (
                        <li key={r.models} className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.5rem] items-center gap-3 text-sm">
                            <span>{["One model", "Two models", "All three"][r.models - 1]}</span>
                            <span className="flex gap-0.5" aria-hidden="true">
                                {FINDINGS.filter((f) => f.foundBy.length === r.models).map((f) => (
                                    <span key={f.id} className="h-3 w-8 rounded-sm bg-primary sm:w-10" />
                                ))}
                            </span>
                            <span className="text-end font-mono font-semibold tabular-nums">{r.count}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <p className="text-sm leading-normal text-muted-foreground">
                Agreement is a signal, not a verdict. Here the uncapped backoff was found by one model only, and it's real.
            </p>
        </figure>
    );
}

/** A picture of a terminal, so dark in both themes (the `dark` class gives its subtree the dark theme's colours). */
function AgentConsole() {
    const mcp = `${window.location.origin}/mcp`;
    // [id, mark, text]: the ids are only keys.
    const lines: [string, string, string][] = [
        ["add", "$", `claude mcp add --transport http triagent ${mcp} \\`],
        ["header", " ", '    --header "Authorization: Bearer tri_…"'],
        ["gap-1", "", ""],
        ["ask", "›", "Work through the review findings on this branch."],
        ["gap-2", "", ""],
        ["claim-1", "→", 'claim_next_issue({ branch: "payments/retry" })'],
        ["got-1", "←", "ocr-3fa9c1d2  critical  src/api/payments.ts:84  found by 3 of 3"],
        ["fix-1", "→", 'update_issue({ status: "resolved", note: "Added the ownership check and a test." })'],
        ["done-1", "←", "resolved"],
        ["claim-2", "→", 'claim_next_issue({ branch: "payments/retry" })'],
        ["got-2", "←", "ocr-71b0e4aa  high  src/payments/retry.ts:41  found by 2 of 3"],
    ];
    return (
        <div className="dark min-w-0 overflow-hidden rounded-lg border border-border bg-[#11161a] text-foreground">
            <p className="border-b border-border px-4 py-2.5 text-sm text-muted-foreground">A coding agent, connected over MCP</p>
            <pre
                className="overflow-x-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap sm:text-sm sm:leading-relaxed"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                tabIndex={0}
            >
                {lines.map(([id, mark, text]) => (
                    <span key={id} className={cn("block min-h-[1lh] ps-5 -indent-5", mark === "←" && "text-muted-foreground")}>
                        {mark && <span className="me-2 inline-block w-3 indent-0 text-muted-foreground select-none">{mark}</span>}
                        {text}
                    </span>
                ))}
            </pre>
        </div>
    );
}

export function LandingPage() {
    const me = useQuery(meQuery);
    const signedIn = me.isSuccess;
    const enter = (size: "default" | "lg") => (
        <Button asChild size={size} className={cn(size === "lg" && "h-11 px-5 text-base")}>
            {signedIn ? <Link to="/dashboard">Open dashboard</Link> : <Link to="/sign-in">Sign in</Link>}
        </Button>
    );

    return (
        <div className="min-h-svh bg-background text-base text-foreground">
            <title>Triagent: every model's review, one list to work through</title>
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2"
            >
                Skip to content
            </a>

            <header className="sticky top-0 z-30 border-b bg-background">
                <div className={cn(COLUMN, "flex h-14 items-center gap-x-4 lg:gap-x-6")}>
                    <Link to="/" className="flex items-center gap-2 text-base font-semibold">
                        <Logo className="size-7" /> Triagent
                    </Link>
                    <nav
                        aria-label="On this page"
                        className="flex items-center gap-x-4 text-sm font-medium whitespace-nowrap text-primary max-md:hidden lg:gap-x-5"
                    >
                        <a href="#how-title" className="py-1 underline-offset-4 hover:underline">
                            How it works
                        </a>
                        <a href="#try" className="py-1 underline-offset-4 hover:underline">
                            Try it
                        </a>
                        <a href="#models" className="py-1 underline-offset-4 hover:underline">
                            Several models
                        </a>
                        <a href="#agents" className="py-1 underline-offset-4 hover:underline">
                            Agents
                        </a>
                        <a href="#yours" className="py-1 underline-offset-4 hover:underline">
                            Running it
                        </a>
                    </nav>
                    <span className="ms-auto flex items-center gap-2">
                        <ThemeToggle />
                        {enter("default")}
                    </span>
                </div>
            </header>

            <main id="main">
                <section aria-labelledby="hero-title" className={cn(COLUMN, "grid gap-10 pt-10 pb-8 sm:gap-12 sm:pt-16 sm:pb-12")}>
                    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-12 gap-y-10 lg:grid-cols-12">
                        <div className="grid gap-6 lg:col-span-5">
                            <h1
                                id="hero-title"
                                className="text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl xl:text-6xl"
                            >
                                <span className="block">Every model's review.</span>{" "}
                                <span className="block">One list to work through.</span>
                            </h1>
                            <p className="max-w-[60ch] text-lg leading-normal text-pretty text-muted-foreground">
                                Triagent reviews your pull requests with the models you choose, merges what they find into a single list,
                                and lets your team and your coding agents work through it together.
                            </p>
                            <div className="flex flex-wrap items-center gap-3">
                                {enter("lg")}
                                <Button asChild variant="outline" size="lg" className="h-11 px-5 text-base">
                                    <a href="#try">Try it here</a>
                                </Button>
                            </div>
                            <p className="text-[0.9375rem] text-muted-foreground">
                                Self-hosted and free software, built on Open Code Review.
                            </p>
                        </div>
                        <div className="min-w-0 lg:col-span-7">
                            <ReviewStage />
                        </div>
                    </div>
                    <p className="max-w-[75ch] text-base leading-normal text-pretty text-muted-foreground" data-testid="providers">
                        Bring your own keys, for 17 providers, among them{" "}
                        <span className="text-foreground">
                            {PROVIDERS.slice(0, -1).join(", ")} and {PROVIDERS.at(-1)}
                        </span>
                        .
                    </p>
                </section>

                <section aria-labelledby="idea-title">
                    <div className={cn(COLUMN, "grid gap-10 py-8 sm:py-12")}>
                        <SectionHeading id="idea-title" title="More reviewers, less to read">
                            Models miss different things, so ask more than one. The trouble is reading three reviews. Triagent reads them
                            for you and hands back one list.
                        </SectionHeading>
                        <InNumbers />
                    </div>
                </section>

                <section aria-labelledby="how-title">
                    <div className={cn(COLUMN, "grid gap-10 py-8 sm:py-12")}>
                        <SectionHeading id="how-title" title="From pull request to fixed, in four steps" />
                        <ol className="grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
                            {STEPS.map((s, i) => (
                                <li key={s.title} className="grid content-start gap-1">
                                    <span className="font-mono text-base text-muted-foreground tabular-nums" aria-hidden="true">
                                        {i + 1}
                                    </span>
                                    <h3 className="text-lg font-semibold">{s.title}</h3>
                                    <p className="text-base leading-normal text-muted-foreground">{s.text}</p>
                                </li>
                            ))}
                        </ol>
                    </div>
                </section>

                <section aria-labelledby="try">
                    <div className={cn(COLUMN, "grid grid-cols-[minmax(0,1fr)] gap-8 py-8 sm:py-12")}>
                        <SectionHeading id="try" title="This is the triage list. It works.">
                            A made-up pull request, reviewed by three models. Filter it, open a finding, see how another model put the same
                            thing, deal with it yourself or hand the next one to an agent. Nothing you do here leaves this page.
                        </SectionHeading>
                        <div className="text-sm">
                            <TryIt />
                        </div>
                    </div>
                </section>

                <section aria-labelledby="models">
                    <div
                        className={cn(COLUMN, "grid grid-cols-[minmax(0,1fr)] items-start gap-x-16 gap-y-10 py-8 sm:py-12 lg:grid-cols-2")}
                    >
                        <div className="grid gap-6">
                            <SectionHeading id="models" title="Ask more than one reviewer">
                                Each model reviews the same change. Findings at the same place become one, marked with every model that
                                found it. The first model's wording leads; the others' are a click away.
                            </SectionHeading>
                            <Points>
                                <li>Sort and filter by agreement, in the app, the API and the tools agents use.</li>
                                <li>If one model fails, the others' findings still arrive, and the review says what's missing.</li>
                                <li>Each model keeps its own record, so you can see what it found, cost and took.</li>
                            </Points>
                        </div>
                        <MergePicture />
                    </div>
                </section>

                <section aria-labelledby="agents">
                    <div
                        className={cn(COLUMN, "grid grid-cols-[minmax(0,1fr)] items-start gap-x-16 gap-y-10 py-8 sm:py-12 lg:grid-cols-2")}
                    >
                        <div className="grid gap-6">
                            <SectionHeading id="agents" title="Built for the agents doing the fixing">
                                Triagent is an MCP server. Claude Code, Codex, OpenCode, Gemini CLI, Cursor and Copilot connect with one
                                command and a token, and a skill teaches them the workflow.
                            </SectionHeading>
                            <Points>
                                <li>Claiming hands each agent a different issue, so ten of them never fix the same thing.</li>
                                <li>Every change carries a note and a revision, so nobody overwrites anybody.</li>
                                <li>Findings flagged for discussion wait for a person. Agents leave them alone.</li>
                            </Points>
                        </div>
                        <AgentConsole />
                    </div>
                </section>

                <section aria-labelledby="yours">
                    <div className={cn(COLUMN, "grid gap-10 pt-8 pb-16 sm:pt-12 sm:pb-24")}>
                        <SectionHeading id="yours" title="Yours to run, and careful with what you give it">
                            Triagent reviews code it hasn't seen before with keys that cost money. It's built on the assumption that both
                            deserve care.
                        </SectionHeading>
                        <dl className="grid gap-x-12 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
                            {REASONS.map((r) => (
                                <div key={r.title} className="grid content-start gap-1">
                                    <dt className="text-base font-semibold">{r.title}</dt>
                                    <dd className="max-w-[65ch] text-base leading-normal text-muted-foreground">{r.text}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </section>

                <section aria-labelledby="start-title" className="border-t bg-muted">
                    <div className={cn(COLUMN, "grid gap-8 py-8 sm:py-12")}>
                        <h2 id="start-title" className="text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
                            <span className="block">The findings are already there.</span>
                            <span className="block">Make them easy to finish.</span>
                        </h2>
                        <div className="flex flex-wrap items-center gap-3">
                            {enter("lg")}
                            <Button asChild variant="outline" size="lg" className="h-11 px-5 text-base">
                                <a href="#try">Back to the demo</a>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t">
                <div className={cn(COLUMN, "flex flex-wrap items-center gap-x-6 gap-y-2 py-8 text-[0.9375rem] text-muted-foreground")}>
                    <span className="flex items-center gap-2 font-semibold text-foreground">
                        <Logo className="size-5" /> Triagent
                    </span>
                    <span>Free software under the AGPL-3.0. Reviews by Open Code Review.</span>
                    <Link to={signedIn ? "/dashboard" : "/sign-in"} className={cn(LINK, "ms-auto py-0.5")}>
                        {signedIn ? "Open dashboard" : "Sign in"}
                    </Link>
                </div>
            </footer>
        </div>
    );
}
