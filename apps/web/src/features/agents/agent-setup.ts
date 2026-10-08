// How each coding agent connects to Triagent's MCP server and where it reads skills from, for the
// Agents & API page. Checked against each agent's documentation (October 2026). Codex, OpenCode, Gemini
// CLI, Cursor and Copilot all read the shared `.agents/skills` folder; Claude Code reads `.claude/skills`.

export interface SetupSnippet {
    label: string;
    code: string;
}

export interface AgentSetup {
    id: string;
    name: string;
    mcp: (url: string, token: string) => SetupSnippet[];
    /** A note under the MCP snippets, if any. */
    mcpNote?: string;
    /** Where the agent reads skills in a repository, and in the home directory for every repository. */
    skills: { repo: string; user: string };
}

/** VS Code's placeholder for a value it asks for (literally, not a JavaScript template). */
const VSCODE_TOKEN_INPUT = ["$", "{input:triagent-token}"].join("");

const SHARED_SKILLS = { repo: ".agents/skills", user: "~/.agents/skills" };

export const AGENTS: AgentSetup[] = [
    {
        id: "claude",
        name: "Claude Code",
        mcp: (url, token) => [
            { label: "In a terminal", code: `claude mcp add --transport http triagent ${url} --header "Authorization: Bearer ${token}"` },
        ],
        skills: { repo: ".claude/skills", user: "~/.claude/skills" },
    },
    {
        id: "codex",
        name: "Codex",
        mcp: (url, token) => [
            {
                label: "Add to ~/.codex/config.toml",
                code: `[mcp_servers.triagent]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
            },
        ],
        mcpNote:
            "Put the token in the file rather than an environment variable: Codex's background process may not see variables set after it started.",
        skills: SHARED_SKILLS,
    },
    {
        id: "opencode",
        name: "OpenCode",
        mcp: (url, token) => [
            {
                label: "In a terminal (--global keeps the token out of the repository's opencode.json)",
                code: `opencode mcp add triagent --global --url ${url} --header "Authorization=Bearer ${token}"`,
            },
        ],
        skills: SHARED_SKILLS,
    },
    {
        id: "gemini",
        name: "Gemini CLI",
        mcp: (url, token) => [
            {
                label: "In a terminal (-s user keeps the token out of the repository's .gemini/settings.json)",
                code: `gemini mcp add --transport http -s user --header "Authorization: Bearer ${token}" triagent ${url}`,
            },
        ],
        skills: SHARED_SKILLS,
    },
    {
        id: "cursor",
        name: "Cursor",
        mcp: (url, token) => [
            {
                label: "Add to ~/.cursor/mcp.json (the global file keeps the token out of the repository)",
                code: JSON.stringify({ mcpServers: { triagent: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
            },
        ],
        mcpNote: "If the file already has servers, add the triagent entry to its mcpServers.",
        skills: SHARED_SKILLS,
    },
    {
        id: "copilot",
        name: "Copilot",
        mcp: (url) => [
            {
                label: "Add to .vscode/mcp.json in VS Code (it asks for the token when the server first starts, so the file holds none)",
                code: JSON.stringify(
                    {
                        inputs: [{ type: "promptString", id: "triagent-token", description: "Triagent API token", password: true }],
                        servers: { triagent: { type: "http", url, headers: { Authorization: `Bearer ${VSCODE_TOKEN_INPUT}` } } },
                    },
                    null,
                    2,
                ),
            },
        ],
        mcpNote: "If the file already has servers, add the triagent entry to its servers and the input to its inputs.",
        skills: SHARED_SKILLS,
    },
];

/** The shell command that installs the skill into `dir` (an agent's skills folder). */
export function skillInstall(origin: string, dir: string): string {
    return `mkdir -p ${dir}/triagent && curl -fsS ${origin}/api/v1/skill.md -o ${dir}/triagent/SKILL.md`;
}
