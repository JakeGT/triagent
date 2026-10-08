// The fake provider from fake-oidc.ts over HTTP, for the browser tests (apps/web/e2e/oidc.spec.ts).
// POST /__control { identity, tamper } chooses who the next sign-in approves. Test use only.

import { serve } from "@hono/node-server";
import { FakeProvider } from "./fake-oidc.ts";

const port = Number(process.env.FAKE_OIDC_PORT);
const issuer = process.env.FAKE_OIDC_ISSUER;
const redirect = process.env.FAKE_OIDC_REDIRECT_URI;
if (!port || !issuer || !redirect) throw new Error("Set FAKE_OIDC_PORT, FAKE_OIDC_ISSUER and FAKE_OIDC_REDIRECT_URI.");

const provider = new FakeProvider({
    issuer,
    clientId: process.env.FAKE_OIDC_CLIENT_ID ?? "triagent",
    clientSecret: process.env.FAKE_OIDC_CLIENT_SECRET ?? "client-secret-for-tests",
    redirectUris: [redirect],
    control: true,
});
serve({ fetch: provider.handle, hostname: "127.0.0.1", port }, () => console.log(`Fake OpenID provider at ${issuer}`));
