import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import { Accounts } from "./accounts.ts";
import { Core } from "./core.ts";
import { EventBus } from "./events.ts";
import { Projects } from "./projects.ts";
import { Reports } from "./reports.ts";
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
}

export function createServices(config: Config, store: Store): Services {
    const events = new EventBus();
    const core = new Core(store, config, events, new Secrets(new SecretBox(config.secretsKey)));
    const reports = new Reports(core);
    const settings = new Settings(core);
    return {
        core,
        config,
        store,
        events,
        accounts: new Accounts(core),
        projects: new Projects(core),
        reports,
        triage: new Triage(core, reports),
        settings,
        webhooks: new Webhooks(core, settings),
    };
}
