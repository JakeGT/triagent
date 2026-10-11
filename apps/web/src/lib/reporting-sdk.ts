// The parts of Sentry's browser SDK the app uses, named one by one so the rest (session replay, the
// feedback widget, tracing) is left out of the build. Loaded only when reporting is on (lib/reporting.ts).

export {
    breadcrumbsIntegration,
    browserApiErrorsIntegration,
    captureException,
    dedupeIntegration,
    eventFiltersIntegration,
    functionToStringIntegration,
    globalHandlersIntegration,
    httpContextIntegration,
    init,
    linkedErrorsIntegration,
    setUser,
    withScope,
} from "@sentry/browser";
