// Agents & API: how to connect coding agents (over MCP) and CI to this workspace. Documentation and
// copy-paste snippets only, with this site's address filled in; tokens are made in Settings.

import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { SCOPE_INFO } from "@triagent/shared";
import { ExternalLink } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Field, NativeSelect } from "@/components/field";
import { FormSection } from "@/components/form";
import { Page, PageHeader, PageMeta } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PREF, prefs } from "@/lib/prefs";
import { projectsQuery } from "@/lib/queries";
import { useWorkspace } from "@/lib/session";
import { AGENTS, type AgentSetup, skillInstall } from "./agent-setup";

const TOKEN = "tri_…";

function Snippet({ code, label }: { code: string; label: string }) {
    const id = useId();
    return (
        <figure className="grid gap-1.5">
            <figcaption id={id} className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                {label}
                <CopyButton value={code} label="Copy" className="h-7" />
            </figcaption>
            <pre
                className="overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable by keyboard
                tabIndex={0}
            >
                <code>{code}</code>
            </pre>
        </figure>
    );
}

/** One tab per coding agent. The MCP and skill sections share the choice. */
function AgentTabs({
    agent,
    onChange,
    children,
}: {
    agent: string;
    onChange: (id: string) => void;
    children: (a: AgentSetup) => ReactNode;
}) {
    return (
        <Tabs value={agent} onValueChange={onChange}>
            <TabsList className="h-auto max-w-full flex-wrap justify-start">
                {AGENTS.map((a) => (
                    <TabsTrigger key={a.id} value={a.id} className="flex-none">
                        {a.name}
                    </TabsTrigger>
                ))}
            </TabsList>
            {AGENTS.map((a) => (
                <TabsContent key={a.id} value={a.id} className="grid gap-2">
                    {children(a)}
                </TabsContent>
            ))}
        </Tabs>
    );
}

function Section({ title, tour, children }: { title: string; tour?: string; children: ReactNode }) {
    return (
        <FormSection title={title} level={2} data-tour={tour}>
            {children}
        </FormSection>
    );
}

export function AgentsPage() {
    const { ws, can } = useWorkspace();
    const search = useSearch({ from: "/authed/w/$ws/agents" });
    const projects = useQuery(projectsQuery(ws));
    const list = projects.data ?? [];
    const remembered = search.project ?? prefs.get(PREF.lastProject(ws)) ?? undefined;
    const [chosen, setChosen] = useState<string | undefined>(undefined);
    const [agent, setAgent] = useState(AGENTS[0]?.id ?? "claude");
    const project = chosen ?? list.find((p) => p.slug === remembered)?.slug ?? list[0]?.slug ?? "my-project";
    const origin = window.location.origin;
    const mcp = `${origin}/mcp`;
    const base = `${origin}/api/v1/w/${ws}/p/${project}`;

    const tokenLink = can("tokens") ? (
        <Link to="/w/$ws/settings/tokens" params={{ ws }} className="underline">
            Settings → API tokens
        </Link>
    ) : (
        "an admin of this workspace"
    );

    return (
        <Page className="max-w-wide">
            <PageMeta title="Agents & API" />
            <PageHeader
                title="Agents & API"
                description="Connect coding agents and CI to this workspace. Each needs an API token, which belongs to this workspace only."
            />

            <Section title="1. Get a token">
                <p className="text-sm">Create one in {tokenLink}. Give it the least access that does the job:</p>
                <ul className="grid gap-1 text-sm">
                    <li>
                        <strong>full</strong>: {SCOPE_INFO.full}
                    </li>
                    <li>
                        <strong>upload</strong>: {SCOPE_INFO.upload}
                    </li>
                    <li>
                        <strong>read</strong>: {SCOPE_INFO.read}
                    </li>
                </ul>
                <p className="text-sm text-muted-foreground">
                    No token can manage members or tokens, or set secrets: those stay with people signed in here. In the snippets below,
                    replace <code className="font-mono">{TOKEN}</code> with your token.
                </p>
            </Section>

            <Section title="2. Connect your agent (MCP)" tour="agents-mcp">
                <p className="text-sm">
                    Triagent is an MCP server at <code className="font-mono">{mcp}</code> (stateless Streamable HTTP). Agents see the tools
                    their token allows: claim the next issue, read it, mark it resolved with a note, and more.
                </p>
                <AgentTabs agent={agent} onChange={setAgent}>
                    {(a) => (
                        <>
                            {a.mcp(mcp, TOKEN).map((s) => (
                                <Snippet key={s.label} label={s.label} code={s.code} />
                            ))}
                            {a.mcpNote && <p className="text-xs text-muted-foreground">{a.mcpNote}</p>}
                        </>
                    )}
                </AgentTabs>
            </Section>

            <Section title="3. Teach it the workflow (skill)">
                <p className="text-sm">
                    The Triagent skill tells an agent how to find the right project from the Git remote, claim issues one at a time, record
                    what it fixed, and upload new reports without pasting them into the conversation.
                </p>
                <AgentTabs agent={agent} onChange={setAgent}>
                    {(a) => (
                        <>
                            <Snippet
                                label="Into a repository (commit it, and everyone's agent learns the workflow)"
                                code={skillInstall(origin, a.skills.repo)}
                            />
                            <Snippet label="For all your repositories" code={skillInstall(origin, a.skills.user)} />
                            {a.skills.repo === ".agents/skills" && (
                                <p className="text-xs text-muted-foreground">
                                    Codex, OpenCode, Gemini CLI, Cursor and Copilot all read{" "}
                                    <code className="font-mono">.agents/skills</code>, so one copy serves them all.
                                </p>
                            )}
                        </>
                    )}
                </AgentTabs>
                <p className="text-sm">
                    Or{" "}
                    <a href="/api/v1/skill.md" className="underline" download="SKILL.md">
                        download SKILL.md
                    </a>{" "}
                    and put it where your agent reads skills.
                </p>
            </Section>

            <Section title="4. Upload reports from CI">
                {list.length > 1 && (
                    <Field label="Project" hint="Fills in the address in the snippets." width="md">
                        {(p) => (
                            <NativeSelect {...p} value={project} onChange={(e) => setChosen(e.target.value)}>
                                {list.map((x) => (
                                    <option key={x.id} value={x.slug}>
                                        {x.name}
                                    </option>
                                ))}
                            </NativeSelect>
                        )}
                    </Field>
                )}
                <p className="text-sm">
                    Make a token with <strong>upload</strong> access, save it as the repository secret{" "}
                    <code className="font-mono">TRIAGENT_TOKEN</code>, and add one of these steps after the one that runs Open Code Review.
                    An upload replaces the branch's report; findings that are still in it keep their triage.
                </p>
                <Tabs defaultValue="post">
                    <TabsList>
                        <TabsTrigger value="post">Upload directly</TabsTrigger>
                        <TabsTrigger value="link">Upload link</TabsTrigger>
                    </TabsList>
                    <TabsContent value="post">
                        <Snippet
                            label="GitHub Actions step"
                            code={`- name: Upload the review to Triagent
  env:
    TRIAGENT_TOKEN: \${{ secrets.TRIAGENT_TOKEN }}
    BRANCH: \${{ github.head_ref || github.ref_name }}
    COMMIT: \${{ github.event.pull_request.head.sha || github.sha }}
  run: |
    jq -n --arg branch "$BRANCH" --arg commit "$COMMIT" --slurpfile report code_review.json \\
      '{branch: $branch, commit: $commit, fileName: "code_review.json", report: $report[0], confirm: true}' |
    curl -fsS -X POST "${base}/reports" \\
      -H "Authorization: Bearer $TRIAGENT_TOKEN" -H "Content-Type: application/json" --data-binary @-`}
                        />
                    </TabsContent>
                    <TabsContent value="link" className="grid gap-2">
                        <p className="text-sm text-muted-foreground">
                            An upload link works once, for 15 minutes, and needs no other credential: handy when the file is large or when
                            the step that sends it shouldn't hold the token.
                        </p>
                        <Snippet
                            label="Shell"
                            code={`URL=$(curl -fsS -X POST "${base}/upload-links" \\
  -H "Authorization: Bearer $TRIAGENT_TOKEN" -H "Content-Type: application/json" \\
  -d "{\\"branch\\": \\"$BRANCH\\", \\"commit\\": \\"$COMMIT\\", \\"confirm\\": true}" | jq -r .url)
curl -fsS -X POST "$URL" --data-binary @code_review.json`}
                        />
                    </TabsContent>
                </Tabs>
            </Section>

            <Section title="The API">
                <ul className="grid gap-1.5 text-sm">
                    <li>
                        <a href="/api/v1/openapi.json" className="inline-flex items-center gap-1 underline">
                            OpenAPI description <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                        : every endpoint and the access it needs. Send <code className="font-mono">Authorization: Bearer {TOKEN}</code>.
                    </li>
                    <li>
                        <a href="/llms.txt" className="inline-flex items-center gap-1 underline">
                            llms.txt <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                        : a plain-text map of the site for agents.
                    </li>
                    <li>
                        Markdown versions of the main views: <code className="font-mono">{base}/issues.md</code>,{" "}
                        <code className="font-mono">{base}/overview.md</code> and{" "}
                        <code className="font-mono">{base}/issues/&#123;id&#125;/markdown</code>.
                    </li>
                </ul>
            </Section>
        </Page>
    );
}
