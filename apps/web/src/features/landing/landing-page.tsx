// The front door, for everyone: what Triagent is, told as a page rather than a dashboard. A review played
// out in the hero, the idea in four numbers, a miniature of the Issues page to try, and what running it
// yourself gives you. Everything shown is made up and stays in the browser; the page asks the server only
// whether you're signed in, to offer the right button.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    ArrowDown,
    ArrowRight,
    Bot,
    Boxes,
    ChartNoAxesCombined,
    Check,
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
import { SeverityMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/context/theme-provider";
import { meQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ReviewStage } from "./review-stage";
import { Rise } from "./rise";
import { agreement, FINDINGS, MODELS } from "./sample";
import { TryIt } from "./try-it";

/** Every model's findings before merging: one for each model that found each finding. */
const RAW = FINDINGS.reduce((n, f) => n + f.foundBy.length, 0);

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
    "Your own server",
];

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
    return <p className={cn("text-sm font-semibold tracking-[0.16em] text-primary uppercase", className)}>{children}</p>;
}

/** A section's heading: centred, large, with room around it. */
function SectionHeading({
    id,
    eyebrow,
    title,
    children,
    align = "center",
}: {
    id: string;
    eyebrow: string;
    title: string;
    children?: ReactNode;
    align?: "center" | "start";
}) {
    return (
        <div className={cn("grid max-w-3xl gap-4", align === "center" && "mx-auto justify-items-center text-center")}>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2
                id={id}
                className="scroll-mt-24 text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem]"
            >
                {title}
            </h2>
            {children && <p className="max-w-2xl text-lg leading-relaxed text-pretty text-muted-foreground">{children}</p>}
        </div>
    );
}

function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const dark = resolvedTheme === "dark";
    return (
        <Button type="button" variant="ghost" size="icon" className="size-9" onClick={() => setTheme(dark ? "light" : "dark")}>
            {dark ? <Sun /> : <Moon />}
            <span className="sr-only">{dark ? "Use the light theme" : "Use the dark theme"}</span>
        </Button>
    );
}

function Tick({ children }: { children: ReactNode }) {
    return (
        <li className="flex gap-3 text-base">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary/12 text-primary" aria-hidden="true">
                <Check className="size-3.5" strokeWidth={3} />
            </span>
            <span>{children}</span>
        </li>
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

const REASONS: { icon: LucideIcon; title: string; text: string; wide?: boolean }[] = [
    {
        icon: KeyRound,
        title: "Your keys, your models",
        text: "Seventeen providers, from Anthropic and OpenAI to Bedrock, Azure and your own server. Keys are encrypted, write-only, and never shown again.",
        wide: true,
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
        wide: true,
    },
];

/** The idea in four numbers, taken from the sample review. */
function InNumbers() {
    const steps: { n: number; label: string; note: string }[] = [
        { n: MODELS.length, label: "models", note: "review the same pull request" },
        { n: RAW, label: "findings", note: "between them, many said twice" },
        { n: FINDINGS.length, label: "to triage", note: "once the same ones are merged" },
        { n: 1, label: "list", note: "for your team and your agents" },
    ];
    return (
        <ol className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
            {steps.map((s, i) => (
                <li key={s.label} className="relative grid justify-items-center gap-1 text-center">
                    {i > 0 && (
                        <ArrowRight
                            className="absolute -start-3 top-6 hidden size-6 -translate-x-1/2 text-muted-foreground/50 lg:block"
                            aria-hidden="true"
                        />
                    )}
                    <span className="text-6xl leading-none font-semibold tracking-tight tabular-nums sm:text-7xl">{s.n}</span>
                    <span className="text-lg font-semibold">{s.label}</span>
                    <span className="max-w-[14rem] text-sm text-muted-foreground">{s.note}</span>
                </li>
            ))}
        </ol>
    );
}

/** Three reviewers' findings as one list: who found each, then how much they agreed. */
function MergePicture() {
    const rows = agreement(FINDINGS);
    const most = Math.max(...rows.map((r) => r.count), 1);
    const shown = FINDINGS.slice(0, 3);
    return (
        <figure className="grid min-w-0 gap-6 rounded-3xl border bg-card p-6 shadow-sm sm:p-8">
            <figcaption className="text-base font-semibold">Found by several, listed once</figcaption>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
                {shown.map((f) => (
                    <li key={f.id} className="flex min-w-0 items-center gap-3 rounded-xl border bg-background px-3.5 py-3">
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
            <div className="grid gap-3 border-t pt-5">
                <p className="text-sm font-medium text-muted-foreground">
                    The sample review: {FINDINGS.length} findings, by how many models found them
                </p>
                <ul className="grid gap-3">
                    {rows.map((r) => (
                        <li key={r.models} className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.5rem] items-center gap-3 text-sm">
                            <span className="text-muted-foreground">{["One model", "Two models", "All three"][r.models - 1]}</span>
                            <span className="h-3 overflow-hidden rounded-full bg-muted">
                                <span
                                    className={cn(
                                        "block h-full rounded-full",
                                        ["bg-primary/45", "bg-primary/70", "bg-primary"][r.models - 1],
                                    )}
                                    style={{ width: `${(r.count / most) * 100}%` }}
                                />
                            </span>
                            <span className="text-end font-semibold tabular-nums">{r.count}</span>
                        </li>
                    ))}
                </ul>
            </div>
            <p className="text-sm text-muted-foreground">
                Agreement is a signal, not a verdict. Here the uncapped backoff was found by one model only, and it's real.
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
        <div className="landing-window dark min-w-0 overflow-hidden rounded-2xl bg-[#11161a] text-foreground">
            <p className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm text-muted-foreground">
                <span className="flex gap-1.5" aria-hidden="true">
                    <span className="size-2.5 rounded-full bg-sev-critical/80" />
                    <span className="size-2.5 rounded-full bg-sev-medium/80" />
                    <span className="size-2.5 rounded-full bg-st-resolved/80" />
                </span>
                A coding agent, connected over MCP
            </p>
            <pre
                className="overflow-x-auto p-5 font-mono text-[0.8rem] leading-relaxed break-words whitespace-pre-wrap"
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
    const enter = (size: "default" | "lg") => (
        <Button asChild size={size} className={cn(size === "lg" && "h-12 px-6 text-base")}>
            {signedIn ? (
                <Link to="/dashboard">
                    Open dashboard <ArrowRight />
                </Link>
            ) : (
                <Link to="/sign-in">
                    Sign in <ArrowRight />
                </Link>
            )}
        </Button>
    );

    return (
        <div className="min-h-svh bg-background text-base">
            <title>Triagent: every model's review, one list to work through</title>
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
            >
                Skip to content
            </a>

            {/* Dark like the hero it sits on, in either theme. */}
            <header className="dark sticky top-0 z-30 border-b border-white/10 bg-[#0a0e12]/95 text-foreground backdrop-blur-md">
                <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5 sm:px-8">
                    <Link to="/" className="flex items-center gap-2.5 text-lg font-semibold">
                        <Logo className="size-8" /> Triagent
                    </Link>
                    <nav aria-label="On this page" className="ms-6 hidden items-center gap-7 text-sm text-muted-foreground md:flex">
                        <a href="#how-title" className="transition-colors hover:text-foreground">
                            How it works
                        </a>
                        <a href="#try" className="transition-colors hover:text-foreground">
                            Try it
                        </a>
                        <a href="#models" className="transition-colors hover:text-foreground">
                            Several models
                        </a>
                        <a href="#agents" className="transition-colors hover:text-foreground">
                            Agents
                        </a>
                        <a href="#yours" className="transition-colors hover:text-foreground">
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
                <section aria-labelledby="hero-title" className="landing-night dark relative overflow-hidden text-foreground">
                    <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
                    <div className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] justify-items-center gap-8 px-5 pt-16 pb-20 text-center sm:px-8 sm:pt-24 sm:pb-28">
                        <p className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm text-muted-foreground">
                            Self-hosted · Free software · Built on Open Code Review
                        </p>
                        <h1
                            id="hero-title"
                            className="max-w-4xl text-5xl leading-[1.04] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl"
                        >
                            Every model's review. <span className="landing-spectrum">One list</span> to work through.
                        </h1>
                        <p className="max-w-2xl text-lg leading-relaxed text-pretty text-muted-foreground sm:text-xl">
                            Triagent reviews your pull requests with the models you choose, merges what they find into a single list, and
                            lets your team and your coding agents work through it together.
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            {enter("lg")}
                            <Button asChild variant="outline" size="lg" className="h-12 px-6 text-base">
                                <a href="#try">
                                    Try it here <ArrowDown />
                                </a>
                            </Button>
                        </div>
                        <div className="mt-6 w-full max-w-4xl min-w-0">
                            <ReviewStage />
                        </div>
                        <div className="mt-4 grid justify-items-center gap-3">
                            <p className="text-sm text-muted-foreground">Bring your own keys, for 17 providers</p>
                            <ul className="flex max-w-3xl flex-wrap justify-center gap-x-6 gap-y-2 text-sm font-medium text-foreground/80">
                                {PROVIDERS.map((p) => (
                                    <li key={p}>{p}</li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </section>

                <section aria-labelledby="idea-title" className="border-b">
                    <Rise className="mx-auto grid max-w-6xl gap-14 px-5 py-20 sm:px-8 sm:py-28">
                        <SectionHeading id="idea-title" eyebrow="The idea" title="More reviewers, less to read">
                            Models miss different things, so ask more than one. The trouble is reading three reviews. Triagent reads them
                            for you and hands back one list.
                        </SectionHeading>
                        <InNumbers />
                    </Rise>
                </section>

                <section aria-labelledby="how-title" className="border-b bg-muted/40">
                    <Rise className="mx-auto grid max-w-6xl gap-14 px-5 py-20 sm:px-8 sm:py-28">
                        <SectionHeading id="how-title" eyebrow="How it works" title="From pull request to fixed, in four steps" />
                        <div className="relative">
                            {/* The line the steps sit on. */}
                            <span
                                className="absolute inset-x-[12.5%] top-7 hidden h-px bg-gradient-to-r from-sev-critical via-sev-medium to-primary lg:block"
                                aria-hidden="true"
                            />
                            <ol className="relative grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
                                {STEPS.map((s, i) => (
                                    <li key={s.title} className="grid content-start justify-items-center gap-3 text-center">
                                        <span className="grid size-14 place-items-center rounded-2xl border bg-background shadow-sm">
                                            <s.icon className="size-6 text-primary" aria-hidden="true" />
                                        </span>
                                        <span className="text-sm font-semibold tracking-wide text-muted-foreground">Step {i + 1}</span>
                                        <h3 className="text-xl font-semibold">{s.title}</h3>
                                        <p className="max-w-xs text-base leading-relaxed text-muted-foreground">{s.text}</p>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    </Rise>
                </section>

                <section aria-labelledby="try" className="border-b">
                    <Rise className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-12 px-5 py-20 sm:px-8 sm:py-28">
                        <SectionHeading id="try" eyebrow="Try it" title="This is the triage list. It works.">
                            A made-up pull request, reviewed by three models. Filter it, open a finding, see how another model put the same
                            thing, deal with it yourself or hand the next one to an agent. Nothing you do here leaves this page.
                        </SectionHeading>
                        <div className="relative text-sm">
                            <div
                                className="absolute inset-x-0 -inset-y-8 rounded-[3rem] bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)] blur-2xl"
                                aria-hidden="true"
                            />
                            <div className="relative">
                                <TryIt />
                            </div>
                        </div>
                    </Rise>
                </section>

                <section aria-labelledby="models" className="border-b bg-muted/40">
                    <Rise className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-2 lg:gap-16">
                        <div className="grid gap-8">
                            <SectionHeading id="models" eyebrow="Several models" title="Ask more than one reviewer" align="start">
                                Each model reviews the same change. Findings at the same place become one, marked with every model that
                                found it. The first model's wording leads; the others' are a click away.
                            </SectionHeading>
                            <ul className="grid gap-4">
                                <Tick>Sort and filter by agreement, in the app, the API and the tools agents use.</Tick>
                                <Tick>If one model fails, the others' findings still arrive, and the review says what's missing.</Tick>
                                <Tick>Each model keeps its own record, so you can see what it found, cost and took.</Tick>
                            </ul>
                        </div>
                        <MergePicture />
                    </Rise>
                </section>

                <section aria-labelledby="agents" className="border-b">
                    <Rise className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-2 lg:gap-16">
                        <AgentConsole />
                        <div className="grid gap-8 lg:order-first">
                            <SectionHeading id="agents" eyebrow="Agents" title="Built for the agents doing the fixing" align="start">
                                Triagent is an MCP server. Claude Code, Codex, OpenCode, Gemini CLI, Cursor and Copilot connect with one
                                command and a token, and a skill teaches them the workflow.
                            </SectionHeading>
                            <ul className="grid gap-4">
                                <Tick>Claiming hands each agent a different issue, so ten of them never fix the same thing.</Tick>
                                <Tick>Every change carries a note and a revision, so nobody overwrites anybody.</Tick>
                                <Tick>Findings flagged for discussion wait for a person. Agents leave them alone.</Tick>
                            </ul>
                        </div>
                    </Rise>
                </section>

                <section aria-labelledby="yours" className="border-b bg-muted/40">
                    <Rise className="mx-auto grid max-w-6xl gap-14 px-5 py-20 sm:px-8 sm:py-28">
                        <SectionHeading id="yours" eyebrow="Running it" title="Yours to run, and careful with what you give it">
                            Triagent reviews code it hasn't seen before with keys that cost money. It's built on the assumption that both
                            deserve care.
                        </SectionHeading>
                        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                            {REASONS.map((r) => (
                                <li
                                    key={r.title}
                                    className={cn(
                                        "grid content-start gap-4 rounded-3xl border bg-card p-7 shadow-sm transition-shadow hover:shadow-md",
                                        r.wide && "lg:col-span-2",
                                    )}
                                >
                                    <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                                        <r.icon className="size-6" aria-hidden="true" />
                                    </span>
                                    <h3 className="text-xl font-semibold">{r.title}</h3>
                                    <p className="text-base leading-relaxed text-muted-foreground">{r.text}</p>
                                </li>
                            ))}
                        </ul>
                    </Rise>
                </section>

                <section aria-labelledby="start-title" className="landing-night dark relative overflow-hidden text-foreground">
                    <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
                    <div className="relative mx-auto grid max-w-6xl justify-items-center gap-8 px-5 py-24 text-center sm:px-8 sm:py-32">
                        <Logo className="size-14" />
                        <h2
                            id="start-title"
                            className="max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl"
                        >
                            The findings are already there. <span className="landing-spectrum">Make them easy to finish.</span>
                        </h2>
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            {enter("lg")}
                            <Button asChild variant="outline" size="lg" className="h-12 px-6 text-base">
                                <a href="#try">Back to the demo</a>
                            </Button>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="dark border-t border-white/10 bg-[#0a0e12] text-foreground">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-8 text-sm text-muted-foreground sm:px-8">
                    <span className="flex items-center gap-2 font-medium text-foreground">
                        <Logo className="size-5" /> Triagent
                    </span>
                    <span>Free software under the AGPL-3.0. Reviews by Open Code Review.</span>
                    <Link to={signedIn ? "/dashboard" : "/sign-in"} className="ms-auto underline underline-offset-2 hover:text-foreground">
                        {signedIn ? "Open dashboard" : "Sign in"}
                    </Link>
                </div>
            </footer>
        </div>
    );
}
