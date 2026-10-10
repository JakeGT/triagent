// The front door, for everyone: what Triagent is, shown by letting people play with it. The headline is a
// diff (three reviews out, one list in); under it are three reviewers to switch on and off and the list
// their findings fly into; further down, a miniature of the Issues page to triage, and three agents to
// send through a list at once. It follows the reader's theme and uses the app's own surfaces, type and
// marks. Everything shown is made up and stays in the browser; the page asks the server only whether
// you're signed in, to offer the right button.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/context/theme-provider";
import { meQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentRace } from "./agent-race";
import { Bench } from "./bench";
import { agreement, FINDINGS } from "./sample";
import { TryIt } from "./try-it";

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
const PROSE = "max-w-[62ch] text-lg leading-normal text-pretty";
/** The room between one section and the next. */
const BAND = "py-14 sm:py-24";
const LINK = "text-primary underline underline-offset-2 hover:no-underline";

/** A section's heading and, under it, what the section is about. Centred over something as wide as the page. */
function SectionHeading({ id, title, centred, children }: { id: string; title: string; centred?: boolean; children?: ReactNode }) {
    return (
        <div className={cn("grid gap-4", centred && "justify-items-center text-center")}>
            <h2 id={id} className="max-w-[24ch] scroll-mt-20 text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-4xl">
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

/** How much the three reviewers agreed, as a bar of one block for each finding. */
function Agreement() {
    const rows = agreement(FINDINGS);
    return (
        <figure className="grid min-w-0 gap-5 rounded-lg border bg-card p-5 sm:p-6">
            <figcaption className="text-base font-semibold">
                The sample review: {FINDINGS.length} findings, by how many reviewers found them
            </figcaption>
            {/* The counts are small enough to count the blocks. */}
            <ul className="grid gap-3">
                {rows.map((r) => (
                    <li key={r.models} className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.5rem] items-center gap-3 text-base">
                        <span>{["One only", "Two", "All three"][r.models - 1]}</span>
                        <span className="flex gap-1" aria-hidden="true">
                            {FINDINGS.filter((f) => f.foundBy.length === r.models).map((f) => (
                                <span key={f.id} className="h-5 w-8 rounded-sm bg-primary sm:w-12" />
                            ))}
                        </span>
                        <span className="text-end font-mono font-semibold tabular-nums">{r.count}</span>
                    </li>
                ))}
            </ul>
            <p className="text-[0.9375rem] leading-normal text-muted-foreground">
                Agreement is a signal, not a verdict. Here the uncapped backoff was found by one reviewer only, and it's real.
            </p>
        </figure>
    );
}

export function LandingPage() {
    const me = useQuery(meQuery);
    const signedIn = me.isSuccess;
    const enter = (size: "default" | "lg") => (
        <Button asChild size={size} className={cn(size === "lg" && "h-12 px-6 text-base")}>
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
                        <a href="#models" className="py-1 underline-offset-4 hover:underline">
                            Several models
                        </a>
                        <a href="#try" className="py-1 underline-offset-4 hover:underline">
                            Try it
                        </a>
                        <a href="#agents" className="py-1 underline-offset-4 hover:underline">
                            Agents
                        </a>
                        <a href="#how-title" className="py-1 underline-offset-4 hover:underline">
                            Setting up
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
                <section aria-labelledby="hero-title" className={cn(COLUMN, "grid gap-10 pt-10 pb-14 sm:gap-12 sm:pt-14 sm:pb-24")}>
                    <div className="grid justify-items-center gap-7 text-center">
                        {/* The headline is the change Triagent makes, written the way a change is: one line out, one in. */}
                        <h1
                            id="hero-title"
                            className="grid max-w-full gap-1.5 text-start text-[clamp(1.75rem,6.6vw,4.5rem)] leading-[1.06] font-semibold tracking-tight sm:gap-2"
                        >
                            <span className="flex items-baseline gap-[0.45em] rounded-md bg-diff-del px-[0.4em] py-[0.14em]">
                                <span className="font-mono text-[0.62em] font-normal text-sev-critical select-none" aria-hidden="true">
                                    −
                                </span>
                                <span className="sr-only">Not </span>
                                <span className="text-foreground/75 line-through decoration-foreground/50 decoration-[0.055em]">
                                    Three reviews to read.
                                </span>
                            </span>{" "}
                            <span className="flex items-baseline gap-[0.45em] rounded-md bg-diff-add px-[0.4em] py-[0.14em]">
                                <span className="font-mono text-[0.62em] font-normal text-st-resolved select-none" aria-hidden="true">
                                    +
                                </span>
                                <span>One list to work through.</span>
                            </span>
                        </h1>
                        <p className="max-w-[58ch] text-lg leading-normal text-pretty text-muted-foreground sm:text-xl sm:leading-normal">
                            Triagent reviews your pull requests with the models you choose, merges what they find into a single list, and
                            lets your team and your coding agents work through it together.
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            {enter("lg")}
                            <Button asChild variant="outline" size="lg" className="h-12 px-6 text-base">
                                <a href="#try">Try it here</a>
                            </Button>
                        </div>
                    </div>
                    <div className="grid gap-4">
                        <Bench />
                        <p className="justify-self-center text-center text-[0.9375rem] text-muted-foreground">
                            A made-up pull request. The switches work: turn a reviewer off and see what goes with it.
                        </p>
                    </div>
                </section>

                <section aria-labelledby="models" className="border-t">
                    <div className={cn(COLUMN, BAND, "grid grid-cols-[minmax(0,1fr)] items-center gap-x-16 gap-y-10 lg:grid-cols-2")}>
                        <div className="grid gap-6">
                            <SectionHeading id="models" title="Ask more than one reviewer">
                                Models miss different things. Each one reviews the same change, and findings at the same place become one,
                                marked with every model that found it. The first model's wording leads; the others' are a click away.
                            </SectionHeading>
                            <Points>
                                <li>Sort and filter by agreement, in the app, the API and the tools agents use.</li>
                                <li>If one model fails, the others' findings still arrive, and the review says what's missing.</li>
                                <li>Each model keeps its own record, so you can see what it found, cost and took.</li>
                            </Points>
                        </div>
                        <div className="grid gap-5">
                            <Agreement />
                            <p className="text-base leading-normal text-pretty text-muted-foreground" data-testid="providers">
                                Bring your own keys, for 17 providers, among them{" "}
                                <span className="text-foreground">
                                    {PROVIDERS.slice(0, -1).join(", ")} and {PROVIDERS.at(-1)}
                                </span>
                                .
                            </p>
                        </div>
                    </div>
                </section>

                <section aria-labelledby="try" className="border-t bg-muted">
                    <div className={cn(COLUMN, BAND, "grid grid-cols-[minmax(0,1fr)] gap-10")}>
                        <SectionHeading id="try" title="This is the triage list. It works." centred>
                            Filter it, open a finding, see how another model put the same thing, deal with it yourself or hand the next one
                            to an agent. Nothing you do here leaves this page.
                        </SectionHeading>
                        <div className="text-sm">
                            <TryIt />
                        </div>
                    </div>
                </section>

                {/* Where agents work is a terminal: this part of the page is dark in both themes. */}
                <section aria-labelledby="agents" className="dark bg-[#0b0f12] text-foreground">
                    <div
                        className={cn(
                            COLUMN,
                            BAND,
                            "grid grid-cols-[minmax(0,1fr)] items-start gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
                        )}
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
                        <AgentRace mcp={`${window.location.origin}/mcp`} />
                    </div>
                </section>

                <section aria-labelledby="how-title">
                    <div className={cn(COLUMN, BAND, "grid gap-12")}>
                        <SectionHeading id="how-title" title="From pull request to fixed, in four steps" />
                        <ol className="grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
                            {STEPS.map((s, i) => (
                                <li key={s.title} className="grid content-start gap-2 border-t-2 border-foreground pt-4">
                                    <span className="font-mono text-5xl leading-none font-semibold tabular-nums" aria-hidden="true">
                                        {i + 1}
                                    </span>
                                    <h3 className="mt-2 text-xl font-semibold">{s.title}</h3>
                                    <p className="text-base leading-normal text-muted-foreground">{s.text}</p>
                                </li>
                            ))}
                        </ol>
                    </div>
                </section>

                <section aria-labelledby="yours" className="border-t">
                    <div className={cn(COLUMN, BAND, "grid gap-10")}>
                        <SectionHeading id="yours" title="Yours to run, and careful with what you give it">
                            Triagent reviews code it hasn't seen before with keys that cost money. It's built on the assumption that both
                            deserve care.
                        </SectionHeading>
                        {/* Set out the way a pull request lists its checks: what was checked, and that it holds. */}
                        <ul className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border bg-card md:grid-cols-2">
                            {REASONS.map((r) => (
                                <li
                                    key={r.title}
                                    className="flex gap-3.5 border-b p-5 max-md:last:border-b-0 md:odd:border-e md:nth-last-[-n+2]:border-b-0"
                                >
                                    <Check className="mt-0.5 size-5 shrink-0 text-st-resolved" aria-hidden="true" />
                                    <div className="grid min-w-0 content-start gap-1">
                                        <h3 className="text-base font-semibold">{r.title}</h3>
                                        <p className="text-base leading-normal text-muted-foreground">{r.text}</p>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>

                <section aria-labelledby="start-title" className="border-t bg-muted">
                    <div className={cn(COLUMN, BAND, "grid justify-items-center gap-8 text-center")}>
                        <h2
                            id="start-title"
                            className="text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl sm:leading-[1.08]"
                        >
                            <span className="block">The findings are already there.</span>
                            <span className="block">Make them easy to finish.</span>
                        </h2>
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            {enter("lg")}
                            <Button asChild variant="outline" size="lg" className="h-12 px-6 text-base">
                                <a href="#try">Back to the demo</a>
                            </Button>
                        </div>
                        <p className="text-[0.9375rem] text-muted-foreground">Self-hosted and free software, built on Open Code Review.</p>
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
