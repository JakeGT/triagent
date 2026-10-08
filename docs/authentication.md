# Authentication

Triagent signs people in one of two ways, chosen with `AUTH_MODE`:

- **`local`** (the default): usernames and passwords kept by Triagent. Good for development and small self-hosted setups.
- **`oidc`**: an OpenID Connect identity provider, such as Authentik, Keycloak, Google or Entra ID. Triagent never sees a password; the provider handles sign-in, multi-factor authentication and who may use the app at all.

Agents and CI use API tokens (`Authorization: Bearer tri_…`) in both modes. Tokens belong to one workspace, and never reach browser-only settings such as secrets, members and tokens.

## Local accounts (`AUTH_MODE=local`)

- The first instance administrator comes from `TRIAGENT_ADMIN_USER` and `TRIAGENT_ADMIN_PASSWORD` (or `_FILE`), created at start-up if there are no accounts yet.
- Instance administrators create accounts under **Settings → Instance → Users**. A new account gets a temporary password and must choose its own at first sign-in.
- Passwords are hashed with scrypt. Failed sign-ins are slowed per address, per address and account, and per account (except from addresses the account recently signed in from).
- Workspace admins add existing accounts by username under **Settings → Workspace → Members**.

## An identity provider (`AUTH_MODE=oidc`)

### How it works

1. **Sign in.** The sign-in page shows a "Sign in with {OIDC_PROVIDER_NAME}" button. It goes to `/auth/login?next=…`, which sends the browser to the provider with an authorization code request: PKCE (S256), `state` and `nonce`. What Triagent must remember until the browser comes back (state, nonce, PKCE verifier, where to go next) is kept in a cookie (`__Host-triagent_oidc`) that is HttpOnly, `SameSite=Lax`, lasts 10 minutes and is encrypted and authenticated with a key derived from `TRIAGENT_SECRETS_KEY` (HKDF). `next` must be a path on this site; anything else becomes `/`.
2. **The way back.** The provider sends the browser to `/auth/callback`. Triagent checks the state against the cookie, exchanges the code (with the client secret and PKCE verifier), and verifies the ID token: its RS256 signature against the provider's published keys (JWKS, refetched when an unknown key appears), `iss`, `aud`, `azp`, `exp`, `nonce` and, when it asked for one, `max_age` against `auth_time`.
3. **The account.** Triagent finds the account by the provider's **issuer and subject (`sub`)**, never by email address, so a changed address keeps the same account and someone else using that address doesn't get it. It refreshes the account's display name and email address, and sets whether it's an instance administrator from membership of `OIDC_ADMIN_GROUP` in the `groups` claim, on every sign-in.
4. **The session.** The session cookie is `__Host-triagent_sid`, HttpOnly, Secure and `SameSite=Lax` (not Strict: the first request back from the provider is a cross-site navigation, and a Strict cookie isn't sent with it). Every write still needs the session's CSRF token and a same-origin `Origin`. The session records when the person authenticated, and the ID token, which is used only as the hint when signing out and never sent to the browser.
5. **Sign out.** `POST /auth/logout` ends the session and returns `{ ok, redirect }`: the provider's `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri` set to `PUBLIC_ORIGIN`. The web app follows it, so you're signed out at the provider too.

When something goes wrong the browser lands on the sign-in page with a short reason (`?error=expired|denied|failed|unavailable`); details go to the server log, never a stack trace or token.

Password sign-in, password changes and password resets answer 404 in this mode. Sessions made with a password stop working when you switch to `oidc` (and the other way round).

### Who gets an account

The first time someone signs in, Triagent creates their account and personal workspace only if:

- `SIGNUP_MODE=open`; or, with `SIGNUP_MODE=invite` (the default),
- they have a pending, unexpired **invite** for their **verified** email address, or
- they're in `OIDC_ADMIN_GROUP`, or
- they would be the very first account.

Otherwise they see "You need an invite", with `INVITE_HINT` if set, and nothing is created.

**Invites** (no email is sent yet: tell the person yourself):

- **Instance invites** (Settings → Instance → Users, for instance administrators) let an address have an account.
- **Workspace invites** (Settings → Workspace → Members, for people who manage members) also add the person to that workspace with a role. Only owners can invite owners. They're accepted on the person's next sign-in even if they already have an account.
- Invites last 14 days (1 to 90). Each address has at most one open invite per workspace (and one for the instance); an expired one makes way for a new one. Creating, revoking and accepting invites are recorded in the audit log.

A provider can limit who may sign in at all (in Authentik, an application policy). Invites then decide who gets an account and where. Both apply.

### Verified email addresses and `OIDC_TRUST_EMAIL`

Invites match only an email address the provider says is verified (`email_verified: true`), because an unverified address is just text the person typed. Triagent also only stores verified addresses on accounts.

Some providers leave `email_verified` out or send `false` even when they did check the address. Authentik does this depending on its version and its email scope mapping. `OIDC_TRUST_EMAIL=true` treats every address from this provider as verified. That's safe only if people can't set their own address at the provider to one they don't control. For example, it's safe with Authentik when:

- accounts are only created through a source that verifies addresses (such as Google), limited by an enrolment allowlist; and
- the user settings flow doesn't let people change their email address (remove the email field from its prompt stage, or make it read-only).

If people can edit their address, someone could set it to an invited address and take that invite. Leave `OIDC_TRUST_EMAIL` off and fix the provider's `email_verified` claim instead.

### Confirming it's you (step-up)

Routes that need the `secrets` permission (GitHub credentials, webhook secrets, model keys) also need a sign-in from the last `REAUTH_MINUTES` (15 by default). An older session gets `401` with `code: "reauth_required"`. The web app then explains and asks:

- **With a provider:** it sends the person to `reauthUrl` (`/auth/login?prompt=login&max_age=0&next=…`), so the provider asks them to authenticate again (including MFA, if the provider requires it). Triagent checks `auth_time` in the new ID token, so a provider that skips the check isn't believed. The person comes back to the same page; anything typed there has to be entered again.
- **With passwords:** `POST /auth/reauth {password}` (slowed like signing in), and the original request is sent again.

The time comes from the ID token's `auth_time` when present, so signing in through a long-lived single sign-on session at the provider counts from when the person actually authenticated there.

### Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_MODE` | `local` | `local` or `oidc`. |
| `PUBLIC_ORIGIN` | (required for `oidc`) | The address people use, e.g. `https://code-review.example.com`. The redirect URI is `PUBLIC_ORIGIN/auth/callback`, and signing out returns here. |
| `OIDC_ISSUER` | (required) | The provider's issuer, exactly as in its discovery document, e.g. `https://auth.example.com/application/o/triagent/`. Must be https (plain http only for localhost). |
| `OIDC_CLIENT_ID` | (required) | The client ID of Triagent's application at the provider. |
| `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_SECRET_FILE` | (required) | The client secret. Prefer the file. |
| `OIDC_SCOPES` | `openid email profile` | Scopes to ask for. Must include `openid`. |
| `OIDC_PROVIDER_NAME` | `your identity provider` | The button's label: "Sign in with …". |
| `OIDC_ADMIN_GROUP` | `platform-admin` | Members of this group (in the `groups` claim) are instance administrators; others aren't. |
| `OIDC_TRUST_EMAIL` | `false` | Treat this provider's addresses as verified even without `email_verified: true`. See above. |
| `SIGNUP_MODE` | `invite` | `invite` or `open`: who gets an account on first sign-in. |
| `INVITE_HINT` | (none) | Shown with new invites and on "You need an invite", e.g. "Ask Jake to add your Google address to the sign-in allowlist". |
| `REAUTH_MINUTES` | `15` | How recent a sign-in must be to change secrets (both modes). |
| `TRIAGENT_SECRETS_KEY_FILE` | (required in production) | Also the source of the key that seals the login cookie. |

`TRIAGENT_ADMIN_USER` is refused in this mode: administrators come from `OIDC_ADMIN_GROUP`.

## Setting up Authentik

These steps use `code-review.example.com` for Triagent and `auth.example.com` for Authentik. On the jaketalling platform those would be `code-review.jaketalling.com` and `auth.jaketalling.com`.

1. **Create the provider.** Applications → Providers → Create → **OAuth2/OpenID Provider**:
   - **Name:** `triagent`.
   - **Authorization flow:** the default explicit or implicit consent flow (implicit skips the consent screen).
   - **Client type:** **Confidential**. Copy the client ID and secret; the secret goes in `OIDC_CLIENT_SECRET_FILE`.
   - **Redirect URIs:** one entry, **strict** match, exactly `https://code-review.example.com/auth/callback`. If your Authentik version lists post-logout redirect URIs separately, add `https://code-review.example.com` there.
   - **Signing key:** choose a certificate (e.g. "authentik Self-signed Certificate"), so ID tokens are signed with **RS256** and published in the JWKS. Without one Authentik signs with the client secret (HS256), which Triagent refuses.
   - **Grant types:** set them **explicitly** to `authorization_code` and `refresh_token`. A provider created through the API or ORM can end up with an empty list, and then every sign-in fails with `invalid_request` ("Invalid grant_type for provider").
   - **Scopes:** keep `openid`, `email` and `profile`. Authentik's default `profile` mapping includes a `groups` claim with the names of the person's groups, which is what `OIDC_ADMIN_GROUP` is matched against. If you use a custom mapping, make sure `groups` is still in the ID token, or add a scope that puts it there and list that scope in `OIDC_SCOPES`.
   - **Subject mode:** keep a stable one (the default, the hashed user ID). Not email or username: if those change, Triagent would see a new person.
   - **Issuer mode:** the default, one issuer per provider (`https://auth.example.com/application/o/<application slug>/`).
2. **Create the application.** Applications → Applications → Create: name `Triagent`, slug `triagent`, provider `triagent`, launch URL `https://code-review.example.com/`.
3. **Limit who can use it.** On the application's **Policy / Group / User Bindings**, bind the groups allowed in, for example `app-users` and `platform-admin`, or a dedicated `code-review-users` if access should be narrower than everyone invited to the platform. Everyone else gets Authentik's "permission denied" page and never reaches Triagent.
4. **Configure Triagent:**

   ```sh
   AUTH_MODE=oidc
   PUBLIC_ORIGIN=https://code-review.example.com
   OIDC_ISSUER=https://auth.example.com/application/o/triagent/
   OIDC_CLIENT_ID=…
   OIDC_CLIENT_SECRET_FILE=/run/secrets/triagent_oidc_client_secret
   OIDC_PROVIDER_NAME=Example
   OIDC_ADMIN_GROUP=platform-admin
   INVITE_HINT=Ask an administrator to add your Google address to the sign-in allowlist.
   ```

5. **Check it.** `https://auth.example.com/application/o/triagent/.well-known/openid-configuration` should list an `end_session_endpoint`, `RS256` under `id_token_signing_alg_values_supported`, and an `issuer` equal to `OIDC_ISSUER`. Sign in as a member of the admin group: Settings → Instance → Users should appear. Then change a secret more than 15 minutes later: you should be sent to Authentik to sign in again and come back.

**Enrolment allowlists.** If Authentik only lets allowlisted accounts enrol (for example, Google accounts on an allowlist in an enrolment policy), a Triagent invite isn't enough on its own: the person's address must be on that allowlist too, or Authentik won't let them in. Say so in `INVITE_HINT`, which appears on each new invite and on the "You need an invite" page.

**Multi-factor authentication** is the provider's job. With Authentik, require it for administrators in the authentication flows; the step-up for secrets (`prompt=login`) runs those flows again.

## What's verified where

The test suite runs the whole flow against a fake provider in the same process (`apps/server/test/fake-oidc.ts`): state, nonce and PKCE mismatches, wrong audience, issuer and `azp`, expired and badly signed ID tokens, `max_age`, open redirects, invites, the email rules, the admin group, subject matching, step-up and sign-out. A browser test (`apps/web/e2e/oidc.spec.ts`) runs it end to end against the same fake provider on another host name.

Check against your real provider when you deploy:

- the `groups` claim is present in the ID token, with group names as you expect;
- `email_verified`: whether it's sent and true, which decides `OIDC_TRUST_EMAIL`;
- `prompt=login` and `max_age=0` make the provider authenticate again and send a fresh `auth_time`;
- the sign-out redirect comes back to `PUBLIC_ORIGIN` (Authentik may need it registered);
- a person outside the application's bound groups is stopped at the provider.
