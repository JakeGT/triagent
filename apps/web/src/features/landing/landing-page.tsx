// What Triagent is, for someone who isn't signed in: a review played out in the hero, a miniature of the
// Issues page to try, and what running it yourself gives you. Everything shown is made up and stays in
// the browser; the page asks the server only whether you're signed in, to offer the right button.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    ArrowDown,
    ArrowRight,
    Bot,
    Boxes,
    ChartNoAxesCombined,
    GitPullRequest,
    KeyRound,
    type LucideIcon,
    Moon,
    ShieldCheck,
    Sun,
    UserCheck,
    Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/context/theme-provider";
import { meQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ReviewStage } from "./review-stage";
import { agreement, FINDINGS, MODELS } from "./sample";
import { TryIt } from "./try-it";

function Eyebrow({ children }: { children: ReactNode }) {
    return <p className="text-xs font-semibold tracking-[0.14em] text-primary uppercase">{children}</p>;
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
    return (
        <div className="grid max-w-2xl gap-2">
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2 id={id} className="scroll-mt-20 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                {title}
            </h2>
            {children && <p className="text-base text-pretty text-muted-foreground">{children}</p>}
        </div>
    );
}

/** The logo's four bars, as a flourish: critical, high, medium, low. */
function Bars({ className }: { className?: string }) {
    return (
        <span className={cn("grid w-28 gap-1", className)} aria-hidden="true">
            <span className="h-1.5 w-full rounded-full bg-sev-critical" />
            <span className="h-1.5 w-3/4 rounded-full bg-sev-high" />
            <span className="h-1.5 w-1/2 rounded-full bg-sev-medium" />
            <span className="h-1.5 w-1/4 rounded-full bg-sev-low" />
        </span>
    );
}

function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const dark = resolvedTheme === "dark";
    return (
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setTheme(dark ? "light" : "dark")}>
            {dark ? <Sun /> : <Moon />}
            <span className="sr-only">{dark ? "Use the light theme" : "Use the dark theme"}</span>
        </Button>
    );
}

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
    {
        icon: GitPullRequest,
        title: "Connect a repository",
        text: "Install the GitHub App on it, or give Triagent a token for that one repository.",
    },
    {
        icon: Boxes,
        title: "Choose your models",
        text: "Bring keys for the providers you use, keep a few favourite models, and pick a default.",
    },
    {
        icon: Bot,
        title: "Reviews run",
        text: "Open Code Review reads each pull request with every model you chose, on a runner of your own.",
    },
    {
        icon: Users,
        title: "Work one list",
        text: "Findings land in one place. People and agents claim them, fix them and say what they did.",
    },
];

const REASONS: { icon: LucideIcon; title: string; text: string }[] = [
    {
        icon: KeyRound,
        title: "Your keys, your models",
        text: "Seventeen providers, from Anthropic and OpenAI to Bedrock, Azure and your own server. Keys are encrypted, write-only, and never shown again.",
    },
    {
        icon: ShieldCheck,
        title: "A runner with nothing to steal",
        text: "Reviews run in a separate process with no database, an empty home directory and credentials made for that one job, revoked when it ends.",
    },
    {
        icon: GitPullRequest,
        title: "A pull request can't review itself",
        text: "Review rules, ignore files and attributes come from the base branch, so a change can't rewrite how it's reviewed or hide its own files.",
    },
    {
        icon: UserCheck,
        title: "Tokens that can't outrank you",
        text: "An agent's token acts for a member and never has more access than they do. No token can read secrets or manage people.",
    },
    {
        icon: Users,
        title: "Sign in your way",
        text: "Local accounts, or your identity provider over OpenID Connect. Invite-only until you decide otherwise.",
    },
    {
        icon: ChartNoAxesCombined,
        title: "Know what it costs",
        text: "Tokens and cost per review and per finding, how long reviews take, and how quickly findings get fixed, by model.",
    },
];

function Agreement() {
    const rows = agreement(FINDINGS);
    const most = Math.max(...rows.map((r) => r.count), 1);
    return (
        <figure className="grid gap-4 rounded-xl border bg-card p-5 shadow-sm">
            <figcaption className="text-sm font-medium">
                The sample review: {FINDINGS.length} findings, by how many models found them
            </figcaption>
            <ul className="grid gap-3">
                {rows.map((r) => (
                    <li key={r.models} className="grid grid-cols-[7.5rem_minmax(0,1fr)_1.5rem] items-center gap-3 text-sm">
                        <span className="flex items-center gap-1.5">
                            {MODELS.map((m, i) => (
                                <span
                                    key={m}
                                    aria-hidden="true"
                                    className={cn("size-2.5 rounded-full", i < r.models ? "bg-primary" : "border border-foreground/30")}
                                />
                            ))}
                            <span className="ms-1 text-muted-foreground">
                                {r.models === MODELS.length ? "All three" : r.models === 1 ? "One" : "Two"}
                            </span>
                        </span>
                        <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                            <span
                                className={cn(
                                    "block h-full rounded-full",
                                    r.models === 1 ? "bg-primary/45" : r.models === 2 ? "bg-primary/70" : "bg-primary",
                                )}
                                style={{ width: `${(r.count / most) * 100}%` }}
                            />
                        </span>
                        <span className="text-end font-medium tabular-nums">{r.count}</span>
                    </li>
                ))}
            </ul>
            <p className="text-sm text-muted-foreground">
                Agreement is a signal, not a verdict. In this review the uncapped backoff was found by one model only, and it's real.
            </p>
        </figure>
    );
}

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
        <div className="dark overflow-hidden rounded-xl border border-white/10 bg-[#11161a] text-foreground shadow-xl shadow-black/20">
            <p className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                <Bot className="size-3.5" aria-hidden="true" /> A coding agent, connected over MCP
            </p>
            <pre
                className="overflow-x-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                tabIndex={0}
            >
                {lines.map(([id, mark, text]) => (
                    <span
                        key={id}
                        className={cn("block min-h-[1lh]", mark === "←" && "text-muted-foreground", mark === "›" && "text-primary")}
                    >
                        {mark && <span className="me-2 inline-block w-3 text-muted-foreground select-none">{mark}</span>}
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
    const enter = signedIn ? (
        <Button asChild>
            <Link to="/">
                Open Triagent <ArrowRight />
            </Link>
        </Button>
    ) : (
        <Button asChild>
            <Link to="/sign-in">
                Sign in <ArrowRight />
            </Link>
        </Button>
    );

    return (
        <div className="min-h-svh bg-background">
            <title>Triagent: every model's review, one list to work through</title>
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
            >
                Skip to content
            </a>

            <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
                <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
                    <Link to="/welcome" className="flex items-center gap-2 text-base font-semibold">
                        <Logo className="size-7" /> Triagent
                    </Link>
                    <nav aria-label="On this page" className="ms-4 hidden items-center gap-5 text-sm text-muted-foreground md:flex">
                        <a href="#try" className="hover:text-foreground">
                            Try it
                        </a>
                        <a href="#models" className="hover:text-foreground">
                            Several models
                        </a>
                        <a href="#agents" className="hover:text-foreground">
                            Agents
                        </a>
                        <a href="#yours" className="hover:text-foreground">
                            Running it
                        </a>
                    </nav>
                    <span className="ms-auto flex items-center gap-2">
                        <ThemeToggle />
                        {enter}
                    </span>
                </div>
            </header>

            <main id="main">
                <section
                    aria-labelledby="hero-title"
                    className="relative overflow-hidden border-b bg-[radial-gradient(70rem_28rem_at_75%_-8rem,color-mix(in_oklch,var(--primary)_16%,transparent),transparent)]"
                >
                    <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:py-20">
                        <div className="grid gap-6">
                            <Bars />
                            <h1 id="hero-title" className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
                                Every model's review. <span className="text-primary">One list</span> to work through.
                            </h1>
                            <p className="max-w-xl text-lg text-pretty text-muted-foreground">
                                Triagent runs Open Code Review on your pull requests with the models you choose, merges what they find into
                                a single list, and lets your team and your coding agents work through it together.
                            </p>
                            <div className="flex flex-wrap items-center gap-3">
                                {enter}
                                <Button asChild variant="outline">
                                    <a href="#try">
                                        Try it here <ArrowDown />
                                    </a>
                                </Button>
                            </div>
                            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                                <li>Self-hosted</li>
                                <li>Free software (AGPL-3.0)</li>
                                <li>17 model providers</li>
                                <li>MCP for agents</li>
                            </ul>
                        </div>
                        <ReviewStage />
                    </div>
                </section>

                <section aria-labelledby="how-title" className="border-b">
                    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6">
                        <SectionHeading id="how-title" eyebrow="How it works" title="From pull request to fixed, in four steps" />
                        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            {STEPS.map((s, i) => (
                                <li key={s.title} className="grid content-start gap-2 rounded-xl border bg-card p-4">
                                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <span className="grid size-6 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                                            {i + 1}
                                        </span>
                                        <s.icon className="size-4" aria-hidden="true" />
                                    </span>
                                    <h3 className="font-semibold">{s.title}</h3>
                                    <p className="text-sm text-muted-foreground">{s.text}</p>
                                </li>
                            ))}
                        </ol>
                    </div>
                </section>

                <section aria-labelledby="try" className="border-b bg-muted/30">
                    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6">
                        <SectionHeading id="try" eyebrow="Try it" title="This is the triage list. It works.">
                            A made-up pull request, reviewed by three models. Filter it, open a finding, see how another model put the same
                            thing, deal with it yourself or hand the next one to an agent. Nothing you do here leaves this page.
                        </SectionHeading>
                        <TryIt />
                    </div>
                </section>

                <section aria-labelledby="models" className="border-b">
                    <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
                        <div className="grid gap-5">
                            <SectionHeading id="models" eyebrow="Several models" title="Ask more than one reviewer">
                                Models miss different things. Triagent has each one review the same change, then treats findings at the same
                                place as one, marked with every model that found it. The first model's wording leads; the others' are a
                                click away.
                            </SectionHeading>
                            <ul className="grid gap-2 text-sm">
                                <li className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                                    Sort and filter by agreement, in the app, the API and the tools agents use.
                                </li>
                                <li className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                                    If one model fails, the others' findings still arrive, and the review says what's missing.
                                </li>
                                <li className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                                    Each model keeps its own record, so you can see what it found, cost and took.
                                </li>
                            </ul>
                        </div>
                        <Agreement />
                    </div>
                </section>

                <section aria-labelledby="agents" className="border-b bg-muted/30">
                    <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
                        <AgentConsole />
                        <div className="grid gap-5 lg:order-first">
                            <SectionHeading id="agents" eyebrow="Agents" title="Built for the agents doing the fixing">
                                Triagent is an MCP server. Claude Code, Codex, OpenCode, Gemini CLI, Cursor and Copilot connect with one
                                command and a token, and a skill teaches them the workflow.
                            </SectionHeading>
                            <ul className="grid gap-2 text-sm">
                                <li className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                                    Claiming hands each agent a different issue, so ten of them never fix the same thing.
                                </li>
                                <li className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                                    Every change carries a note and a revision, so nobody overwrites anybody.
                                </li>
                                <li className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                                    Findings flagged for discussion wait for a person. Agents leave them alone.
                                </li>
                            </ul>
                        </div>
                    </div>
                </section>

                <section aria-labelledby="yours" className="border-b">
                    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 sm:px-6">
                        <SectionHeading id="yours" eyebrow="Running it" title="Yours to run, and careful with what you give it">
                            Triagent reviews code it hasn't seen before with keys that cost money. It's built on the assumption that both
                            deserve care.
                        </SectionHeading>
                        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {REASONS.map((r) => (
                                <li key={r.title} className="grid content-start gap-2 rounded-xl border bg-card p-4">
                                    <r.icon className="size-5 text-primary" aria-hidden="true" />
                                    <h3 className="font-semibold">{r.title}</h3>
                                    <p className="text-sm text-muted-foreground">{r.text}</p>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>

                <section aria-labelledby="start-title">
                    <div className="mx-auto grid max-w-6xl justify-items-center gap-5 px-4 py-16 text-center sm:px-6">
                        <Bars className="justify-items-center" />
                        <h2 id="start-title" className="max-w-xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                            The findings are already there. Make them easy to finish.
                        </h2>
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            {enter}
                            <Button asChild variant="outline">
                                <a href="#try">Back to the demo</a>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
                    <span className="flex items-center gap-2 font-medium text-foreground">
                        <Logo className="size-5" /> Triagent
                    </span>
                    <span>Free software under the AGPL-3.0. Reviews by Open Code Review.</span>
                    <Link to="/sign-in" className="ms-auto underline underline-offset-2 hover:text-foreground">
                        Sign in
                    </Link>
                </div>
            </footer>
        </div>
    );
}
