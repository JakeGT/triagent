import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import { Accounts } from "./accounts.ts";
import { Core } from "./core.ts";
import { EventBus } from "./events.ts";
import { Automation } from "./github/automation.ts";
import { Github } from "./github/service.ts";
import { History } from "./history.ts";
import { Models } from "./models.ts";
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
}

export function createServices(config: Config, store: Store): Services {
    const events = new EventBus();
    const core = new Core(store, config, events, new Secrets(new SecretBox(config.secretsKey)));
    const reports = new Reports(core);
    const settings = new Settings(core);
    const projects = new Projects(core);
    const history = new History(core);
    const models = new Models(core);
    const webhooks = new Webhooks(core, settings);
    const github = new Github(core, settings, projects);
    const runs = new Runs(core, github, reports, history, models, settings);
    const automation = new Automation(core, github, runs, reports, settings);
    webhooks.automation = automation;
    return {
        core,
        config,
        store,
        events,
        accounts: new Accounts(core),
        projects,
        reports,
        triage: new Triage(core, reports),
        settings,
        webhooks,
        history,
        models,
        github,
        runs,
        automation,
    };
}
