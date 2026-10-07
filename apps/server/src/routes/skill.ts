// The agent skill (skills/triagent/SKILL.md), served so the Agents & API page can offer a one-line
// install. Public: it's documentation and holds no data.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "../errors.ts";
import { markdown, type Route, route } from "../http/route.ts";

const SKILL = path.resolve(import.meta.dirname, "../../../../skills/triagent/SKILL.md");

export const skillRoutes: Route[] = [
    route({
        method: "GET",
        path: "/api/v1/skill.md",
        scope: "public",
        tag: "Agents",
        summary: "The Triagent skill for coding agents (SKILL.md)",
        produces: "markdown",
        async handler() {
            try {
                return markdown(await readFile(SKILL, "utf8"));
            } catch {
                throw notFound("This server has no copy of the skill. See skills/triagent/SKILL.md in the Triagent repository.");
            }
        },
    }),
];
