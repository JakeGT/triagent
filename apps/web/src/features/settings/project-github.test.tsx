import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GithubSettings } from "@/lib/types";
import { ChecksNote, tokenTitle } from "./project-github";

const settings = (over: Partial<GithubSettings>): GithubSettings => ({
    repoUrl: "https://github.com/acme/app",
    defaultBranch: "main",
    connection: { method: "token", token: { name: "GitHub token", set: true, hint: null, setBy: null, setAt: null } },
    webhook: { secretSet: false, setBy: null, setAt: null, url: "" },
    mode: "token",
    tokenFrom: "project",
    workspace: { method: "app", server: "https://github.com", ownServer: false, token: null },
    checksReadable: false,
    app: { available: false },
    installations: [],
    repository: null,
    ...over,
});

describe("ChecksNote", () => {
    it("says a token can't read check runs", () => {
        render(<ChecksNote data={settings({})} />);
        expect(screen.getByTestId("checks-note").textContent).toMatch(/doesn't let this access token read check runs/);
    });

    it("says nothing once nothing is connected, or while checks can be read", () => {
        const { rerender } = render(<ChecksNote data={settings({ mode: "none" })} />);
        expect(screen.queryByTestId("checks-note")).toBeNull();
        rerender(<ChecksNote data={settings({ checksReadable: null })} />);
        expect(screen.queryByTestId("checks-note")).toBeNull();
    });
});

describe("tokenTitle", () => {
    const app = { available: true as const, name: "Triagent", slug: "triagent", htmlUrl: "" };
    it("says what the project's token is used instead of", () => {
        expect(tokenTitle(settings({}))).toBe("Access token");
        expect(tokenTitle(settings({ app }))).toBe("Access token (instead of the app)");
        expect(
            tokenTitle(
                settings({
                    app,
                    workspace: { method: "token", server: "https://github.com", ownServer: false, token: { owner: "o", kind: "classic" } },
                }),
            ),
        ).toBe("Access token (instead of the workspace's)");
        // On the workspace's own Enterprise server the app can't be used.
        expect(tokenTitle(settings({ app, workspace: { method: "token", server: "https://ghe.x", ownServer: true, token: null } }))).toBe(
            "Access token",
        );
    });
});
