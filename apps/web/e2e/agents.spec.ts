// Agents & API: setup instructions for each coding agent, with this site's address filled in.

import { ADMIN_PASSWORD, ADMIN_USER } from "./constants";
import { expect, seedProject, signInPage, test } from "./fixtures";

test("each agent gets MCP and skill instructions, and both sections follow the chosen agent", async ({ page, admin, baseURL }) => {
    const { ws } = await seedProject(admin);
    await signInPage(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.goto(`/w/${ws}/agents`);
    const mcp = page.getByRole("region", { name: /Connect your agent/ });
    const skill = page.getByRole("region", { name: /Teach it the workflow/ });

    await expect(skill.locator("pre").first()).toContainText(".claude/skills/triagent/SKILL.md");
    await expect(skill.locator("pre").first()).toContainText(`${baseURL}/api/v1/skill.md`);

    for (const name of ["Codex", "OpenCode", "Gemini CLI", "Cursor", "Copilot"]) {
        await mcp.getByRole("tab", { name }).click();
        await expect(skill.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
        await expect(mcp.locator("pre").first()).toContainText(`${baseURL}/mcp`);
        await expect(skill.locator("pre").first()).toContainText("mkdir -p .agents/skills/triagent");
        await expect(skill.locator("pre").nth(1)).toContainText("~/.agents/skills/triagent/SKILL.md");
    }
    // VS Code asks for the token: the file holds its placeholder, not a token.
    await expect(mcp.locator("pre").first()).toContainText('"Authorization": "Bearer ${input:triagent-token}"');

    // The skill installs as written.
    const res = await page.request.get("/api/v1/skill.md");
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(/^---\nname: triagent\n/);
});
