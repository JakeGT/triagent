// What's known about the request being answered, wherever the code answering it has got to: every log
// line written on the way carries the request's id, so one request's lines can be found together, and
// the same id goes back to the caller (X-Request-Id, and `requestId` with a 500) to quote.

import { AsyncLocalStorage } from "node:async_hooks";
import { setLogContext } from "@triagent/shared/log";

export interface RequestInfo {
    id: string;
    method: string;
    /** The route as declared (/api/v1/w/{workspace}/…), once one has matched. */
    route?: string;
    /** The account making it: the person's id, or the id of the person a token acts for. */
    user?: string;
    workspace?: string;
    project?: string;
}

const requests = new AsyncLocalStorage<RequestInfo>();

export const runInRequest = <T>(info: RequestInfo, fn: () => T): T => requests.run(info, fn);
export const currentRequest = (): RequestInfo | undefined => requests.getStore();

setLogContext(() => {
    const r = requests.getStore();
    if (!r) return undefined;
    return { request: r.id, method: r.method, route: r.route, user: r.user, workspace: r.workspace, project: r.project };
});
