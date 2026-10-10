// How many reviews may run at once: on the instance, in any one workspace, and in a workspace given a
// limit of its own. An instance admin sets them (Settings → Instance → Reviews, and the Workspaces page);
// until one is saved, REVIEW_CONCURRENCY and REVIEW_CONCURRENCY_PER_WORKSPACE are what apply. They're
// one instance setting, read each time a runner asks for work, so a change needs no restart: it applies
// to the next review to start, and never stops one that's running.

import { badRequest, notFound } from "../errors.ts";
import { now } from "../security.ts";
import type { Repos } from "../store/types.ts";
import type { Actor, Core } from "./core.ts";

const KEY = "review-limits";
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;

export interface ReviewLimits {
    /** At once on the instance. */
    instance: number;
    /** At once in a workspace without a limit of its own. */
    perWorkspace: number;
    /** Workspaces with a limit of their own, by id. */
    workspaces: Record<string, number>;
    /** Who last saved the instance's two numbers; null while the environment's still apply. */
    saved: { by: string; at: string } | null;
}

const valid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MIN_LIMIT && v <= MAX_LIMIT;

function check(value: unknown, what: string): number {
    if (!valid(value)) throw badRequest(`${what} must be a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}.`);
    return value;
}

export class ReviewLimitSettings {
    private readonly core: Core;

    constructor(core: Core) {
        this.core = core;
    }

    /** What the environment says: the limits of an instance that has never saved any. */
    get defaults(): { instance: number; perWorkspace: number } {
        return { instance: this.core.config.reviewConcurrency, perWorkspace: this.core.config.reviewConcurrencyPerWorkspace };
    }

    /** The limits as they stand. Anything stored that isn't a limit is read as not set. */
    async read(repos: Repos = this.core.store): Promise<ReviewLimits> {
        const raw = ((await repos.instanceSettings.get(KEY)) ?? {}) as Record<string, unknown>;
        const defaults = this.defaults;
        const saved = raw.saved as { by?: unknown; at?: unknown } | undefined;
        const own = raw.workspaces && typeof raw.workspaces === "object" ? (raw.workspaces as Record<string, unknown>) : {};
        return {
            instance: valid(raw.instance) ? raw.instance : defaults.instance,
            perWorkspace: valid(raw.perWorkspace) ? raw.perWorkspace : defaults.perWorkspace,
            workspaces: Object.fromEntries(Object.entries(own).filter((e): e is [string, number] => valid(e[1]))),
            saved:
                valid(raw.instance) && valid(raw.perWorkspace) && typeof saved?.by === "string" && typeof saved.at === "string"
                    ? { by: saved.by, at: saved.at }
                    : null,
        };
    }

    /**
     * How many reviews a workspace may run at once: its own limit, or the one for every workspace. Either
     * way no more than the instance's, which nothing lets a workspace pass.
     */
    static forWorkspace(limits: ReviewLimits, workspaceId: string): number {
        const own = Object.hasOwn(limits.workspaces, workspaceId) ? (limits.workspaces[workspaceId] as number) : limits.perWorkspace;
        return Math.min(own, limits.instance);
    }

    private stored(limits: ReviewLimits): Record<string, unknown> {
        return {
            // The environment's stay the defaults until the two numbers are saved, even once a workspace has its own.
            ...(limits.saved ? { instance: limits.instance, perWorkspace: limits.perWorkspace, saved: limits.saved } : {}),
            workspaces: limits.workspaces,
        };
    }

    /** Save the instance's two limits. */
    async set(actor: Actor, input: { instance: unknown; perWorkspace: unknown }): Promise<ReviewLimits> {
        const instance = check(input.instance, "The number of reviews at once on this instance");
        const perWorkspace = check(input.perWorkspace, "The number of reviews at once in one workspace");
        return this.core.write(actor, async (w) => {
            const before = await this.read(w.tx);
            // The same numbers again change nothing, and aren't recorded as a change (but are saved, the first time).
            if (before.saved && before.instance === instance && before.perWorkspace === perWorkspace) return before;
            const next: ReviewLimits = { ...before, instance, perWorkspace, saved: { by: actor.name, at: now() } };
            await w.tx.instanceSettings.put(KEY, this.stored(next));
            await w.audit({
                workspaceId: null,
                kind: "settings",
                target: "instance:review-limits",
                changes: {
                    ...(before.instance !== instance || !before.saved ? { instance: { from: before.instance, to: instance } } : {}),
                    ...(before.perWorkspace !== perWorkspace || !before.saved
                        ? { perWorkspace: { from: before.perWorkspace, to: perWorkspace } }
                        : {}),
                },
            });
            return next;
        });
    }

    /** Give a workspace a limit of its own, or with null take it away (it uses the one for every workspace again). */
    async setWorkspace(actor: Actor, workspaceId: string, limit: unknown): Promise<{ workspaceId: string; reviewLimit: number | null }> {
        const n = limit === null ? null : check(limit, "A workspace's number of reviews at once");
        return this.core.write(actor, async (w) => {
            const workspace = await w.tx.workspaces.get(workspaceId);
            if (!workspace) throw notFound("No such workspace.");
            const before = await this.read(w.tx);
            const was = Object.hasOwn(before.workspaces, workspaceId) ? (before.workspaces[workspaceId] as number) : null;
            if (was === n) return { workspaceId, reviewLimit: n };
            const { [workspaceId]: _removed, ...others } = before.workspaces;
            // Limits of workspaces deleted since are dropped as this one is saved.
            const ids = new Set((await w.tx.workspaces.list()).map((x) => x.id));
            const workspaces = Object.fromEntries(Object.entries(others).filter(([id]) => ids.has(id)));
            await w.tx.instanceSettings.put(
                KEY,
                this.stored({ ...before, workspaces: n === null ? workspaces : { ...workspaces, [workspaceId]: n } }),
            );
            const changes = { reviewLimit: { from: was, to: n } };
            await w.audit({ workspaceId: null, kind: "settings", target: `workspace:${workspace.slug}:review-limit`, changes });
            await w.audit({ workspaceId, kind: "settings", target: "review-limit", changes });
            return { workspaceId, reviewLimit: n };
        });
    }
}
