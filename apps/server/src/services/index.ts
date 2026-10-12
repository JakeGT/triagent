import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import { Accounts } from "./accounts.ts";
import { Allowances } from "./allowances.ts";
import { Analyst } from "./analyst.ts";
import { AnalyticsService } from "./analytics.ts";
import { BrowserReports } from "./browser-reports.ts";
import { Catalogue } from "./catalogue.ts";
import { Core } from "./core.ts";
import { EventBus } from "./events.ts";
import { Automation } from "./github/automation.ts";
import { Github } from "./github/service.ts";
import { History } from "./history.ts";
import { Invites } from "./invites.ts";
import { ModelLists } from "./model-lists.ts";
import { ModelSetup } from "./model-setup.ts";
import type { Lookup } from "./model-urls.ts";
import { Models } from "./models.ts";
import { Oidc } from "./oidc.ts";
import { CommonIssues } from "./patterns.ts";
import { Prices } from "./prices.ts";
import { Projects } from "./projects.ts";
import { Reports } from "./reports.ts";
import { ReviewLimitSettings } from "./review-limits.ts";
import { Runs } from "./runs.ts";
import { SecretBox, Secrets } from "./secrets.ts";
import { Settings } from "./settings.ts";
import { Triage } from "./triage.ts";
import { Tutorial } from "./tutorial.ts";
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
    tutorial: Tutorial;
    settings: Settings;
    webhooks: Webhooks;
    history: History;
    models: Models;
    modelLists: ModelLists;
    github: Github;
    runs: Runs;
    automation: Automation;
    catalogue: Catalogue;
    prices: Prices;
    allowances: Allowances;
    reviewLimits: ReviewLimitSettings;
    analytics: AnalyticsService;
    /** Asking a model to write about reviews and findings. */
    analyst: Analyst;
    /** A project's common issues, and likely false positives. */
    patterns: CommonIssues;
    invites: Invites;
    /** The identity provider, when AUTH_MODE=oidc. */
    oidc: Oidc | null;
    /** Where the web app's error reports go, when they're sent on to Sentry. */
    browserReports: BrowserReports | null;
}

/** Test seams: the clock, how to reach OpenRouter and model providers, and how host names resolve. */
export interface ServiceOptions {
    now?: () => Date;
    fetch?: typeof fetch;
    lookup?: Lookup;
}

export function createServices(config: Config, store: Store, options: ServiceOptions = {}): Services {
    const events = new EventBus();
    const core = new Core(store, config, events, new Secrets(new SecretBox(config.secretsKey)));
    const clock = options.now ?? (() => new Date());
    const history = new History(core);
    const reports = new Reports(core, history);
    const setup = new ModelSetup(core, options.lookup);
    const settings = new Settings(core, setup);
    const projects = new Projects(core);
    const catalogue = new Catalogue({ enabled: config.openrouterCatalogue, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const prices = new Prices(core, catalogue);
    const reviewLimits = new ReviewLimitSettings(core);
    const allowances = new Allowances(core, clock, setup, reviewLimits);
    const models = new Models(core, history, allowances, setup, settings);
    const modelLists = new ModelLists(setup, catalogue, options.fetch ? { fetch: options.fetch } : {});
    const webhooks = new Webhooks(core, settings);
    const github = new Github(core, settings, projects);
    const runs = new Runs(core, github, reports, history, models, settings, reviewLimits);
    const automation = new Automation(core, github, runs, reports, settings);
    webhooks.automation = automation;
    const invites = new Invites(core);
    const triage = new Triage(core, reports);
    const analytics = new AnalyticsService(core, projects, reports, prices, () => clock().getTime());
    const analyst = new Analyst(core, setup, runs, reports, analytics, prices, projects, {
        now: () => clock().getTime(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // After automation's own look at a finished review: what the workspace asked to have written about it.
    const finished = runs.onFinished;
    runs.onFinished = (job, project) => {
        finished(job, project);
        analyst.reviewFinished(job);
    };
    return {
        core,
        config,
        store,
        events,
        accounts: new Accounts(core, invites),
        projects,
        reports,
        triage,
        tutorial: new Tutorial(core, projects, reports, triage, history),
        settings,
        webhooks,
        history,
        models,
        modelLists,
        catalogue,
        prices,
        allowances,
        reviewLimits,
        analytics,
        analyst,
        patterns: new CommonIssues(core, reports, analyst),
        github,
        runs,
        automation,
        invites,
        oidc: config.oidc ? new Oidc(config.oidc, config.publicOrigin, config.secretsKey) : null,
        browserReports: config.telemetry?.browserDsn ? new BrowserReports(config.telemetry.browserDsn, options.fetch) : null,
    };
}
