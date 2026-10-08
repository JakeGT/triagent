import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import { Accounts } from "./accounts.ts";
import { Allowances } from "./allowances.ts";
import { AnalyticsService } from "./analytics.ts";
import { Catalogue } from "./catalogue.ts";
import { Core } from "./core.ts";
import { EventBus } from "./events.ts";
import { Automation } from "./github/automation.ts";
import { Github } from "./github/service.ts";
import { History } from "./history.ts";
import { Invites } from "./invites.ts";
import { Models } from "./models.ts";
import { Oidc } from "./oidc.ts";
import { Prices } from "./prices.ts";
import { Projects } from "./projects.ts";
import { Reports } from "./reports.ts";
import { Runs } from "./runs.ts";
import { SecretBox, Secrets } from "./secrets.ts";
import { Settings } from "./settings.ts";
import { Triage } from "./triage.ts";
import { Webhooks } from "./webhooks.ts";

export interface Services {
    core: Core;
    config: Config;
    store: Store;
    events: EventBus;
    accounts: Accounts;
    projects: Projects;
    reports: Reports;
    triage: Triage;
    settings: Settings;
    webhooks: Webhooks;
    history: History;
    models: Models;
    github: Github;
    runs: Runs;
    automation: Automation;
    catalogue: Catalogue;
    prices: Prices;
    allowances: Allowances;
    analytics: AnalyticsService;
    invites: Invites;
    /** The identity provider, when AUTH_MODE=oidc. */
    oidc: Oidc | null;
}

/** Test seams: the clock, and how to reach OpenRouter. */
export interface ServiceOptions {
    now?: () => Date;
    fetch?: typeof fetch;
}

export function createServices(config: Config, store: Store, options: ServiceOptions = {}): Services {
    const events = new EventBus();
    const core = new Core(store, config, events, new Secrets(new SecretBox(config.secretsKey)));
    const clock = options.now ?? (() => new Date());
    const history = new History(core);
    const reports = new Reports(core, history);
    const settings = new Settings(core);
    const projects = new Projects(core);
    const catalogue = new Catalogue({ enabled: config.openrouterCatalogue, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const prices = new Prices(core, catalogue);
    const allowances = new Allowances(core, clock);
    const models = new Models(core, history, allowances);
    const webhooks = new Webhooks(core, settings);
    const github = new Github(core, settings, projects);
    const runs = new Runs(core, github, reports, history, models, settings);
    const automation = new Automation(core, github, runs, reports, settings);
    webhooks.automation = automation;
    const invites = new Invites(core);
    return {
        core,
        config,
        store,
        events,
        accounts: new Accounts(core, invites),
        projects,
        reports,
        triage: new Triage(core, reports),
        settings,
        webhooks,
        history,
        models,
        catalogue,
        prices,
        allowances,
        analytics: new AnalyticsService(core, projects, reports, prices, () => clock().getTime()),
        github,
        runs,
        automation,
        invites,
        oidc: config.oidc ? new Oidc(config.oidc, config.publicOrigin, config.secretsKey) : null,
    };
}
