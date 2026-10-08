# Third-party notices

Triagent is licensed under the GNU AGPL v3 (see [LICENSE](LICENSE)). It runs, but does not include in this repository, the following software. Container images built from this repository bundle it, with its licence text, unmodified.

| Software | Licence | Used for |
|---|---|---|
| [Open Code Review](https://github.com/alibaba/open-code-review) (`@alibaba-group/open-code-review`) | Apache-2.0 | Running the code reviews. The runner starts it as a separate program; the runner image installs version 1.12.12 from npm. |
| [Git](https://git-scm.com) | GPL-2.0 | Fetching the code to review. The runner image installs Alpine's package and runs it as a separate program. |
| [Node.js](https://nodejs.org) (`node:24-alpine` images) | MIT and others | Running the server and the runner. |

## Included in this repository

### shadcn-admin (the web app's starting point)

`apps/web` started from [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) (commit `e16c87f`), MIT licence:

> Copyright (c) 2024 Sat Naing

The full licence text is kept in [apps/web/src/components/ui/LICENSE-shadcn-admin.txt](apps/web/src/components/ui/LICENSE-shadcn-admin.txt).

What was kept and adapted:

- The [shadcn/ui](https://ui.shadcn.com) components in `apps/web/src/components/ui` (alert, alert dialog, badge, button, card, checkbox, collapsible, dialog, dropdown menu, input, label, popover, separator, sheet, sidebar, skeleton, sonner, switch, table, tabs, textarea, tooltip), reformatted for this repository. The sidebar remembers its state in `localStorage` instead of a cookie, and its labels were reworded.
- The theme tokens (CSS variables) and base styles in `apps/web/src/styles/index.css`, with Triagent's own colours, severity and status colours, and fonts.
- The theme provider, password input, skip link and mobile hook, rewritten for this app.
- The layout: a grouped, collapsible sidebar with a workspace switcher and a user menu, and a settings section with its own navigation.

What was removed: every demo page and its sample data (dashboard, tasks, users, apps, chats, help centre, error pages), Clerk and the other sign-in demos, the command menu, Axios, Zustand, React Hook Form, ESLint, Prettier and Knip. Radix Select and Scroll Area were left out because they add `<style>` elements at runtime, which the Content Security Policy refuses.

### Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono (fonts)

The web app self-hosts these fonts (`apps/web/src/assets/fonts`), unmodified, under the [SIL Open Font License 1.1](apps/web/src/assets/fonts/OFL.txt):

> Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next)
>
> Copyright 2020-2024 The Atkinson Hyperlegible Mono Project Authors (https://github.com/googlefonts/atkinson-hyperlegible-next-mono)

### Libraries

The web app's npm dependencies (React, TanStack Router, Query and Table, Radix UI, Tailwind CSS, sonner, lucide-react, react-markdown and others) are under permissive licences (MIT, ISC, Apache-2.0, 0BSD, Unlicense); `pnpm licenses list --filter @triagent/web` lists them. The built app includes them in its JavaScript and CSS bundles.
