# Design language: Triagent

Shared rules live in `~/Projects/Common/rules.md` (cited below as V1, D3, S5 and so on). This file holds what is
specific to Triagent. Read it before changing anything in `apps/web`.

## Subject

- **What it is:** a place to work through Open Code Review findings: several models review a change, their findings
  are merged into one list, and people and coding agents triage it.
- **Who uses it:** developers and the agents they run. A few administrators who set up models, GitHub and members.
- **The one job:** get from "a review finished" to "every finding is fixed, declined or handed to someone".
- **Context of use:** at a desk, pointer and keyboard, alongside an editor and a terminal. Short visits many times a
  day, and long sittings after a big review. Phones are for checking on a review, not for triage in bulk.
- **Stakes:** deleting a project or a branch's report and its triage; revoking a token an agent is using; spending
  model tokens on a review nobody wanted; marking a real finding "won't fix".

## The world it comes from

- A pull request: a title with a number, a branch name, a commit, checks that pass or fail.
- A diff: lines that start with `+` and `-`, tinted green and red, in a monospaced face.
- A finding: a severity, a sentence, and `path/to/file.ts:41`. The path and line matter as much as the sentence.
- A terminal: where agents and CI talk to Triagent. Dark, monospaced, one command at a time.
- Triage itself: sorting by urgency, most urgent first, and marking each thing so the next person doesn't redo it.
- An issue tracker's table: rows to scan, a panel to read one, a status to set.

## Direction

**Dense utilitarian working surfaces; the product's own marks as the only expression.** People come to clear a list,
so the list, the finding panel and the tables are compact, aligned and quiet: neutral surfaces, one action colour,
and colour otherwise reserved for severity and status. What makes it recognisably Triagent is not decoration but
three marks that carry information everywhere they appear:

- the **severity mark**: a shape and a colour together (triangle critical, diamond high, square medium, circle low);
- the **agreement dots**: one dot per model, filled for each model that found the finding;
- `path:line` in the monospaced face.

The landing page uses the same surfaces, type and marks at a larger scale, and it is the one place allowed to be
loud: its pictures are working pieces of the product that the reader plays with, in place of illustration. Its
headline is written as a diff (one line struck out in the removed tint, one added), because a change is what
Triagent's users read all day and a change is what it offers them.

**The memorable thing:** one finding row — severity mark, sentence, `path:line`, agreement dots — and three models'
reviews collapsing into it. On the landing page that is literal: three reviewers with switches, and their findings
flying into one list.

**Directions considered and rejected:**

- *Dark hero with a glow and a gradient headline* (the previous landing page): the "dark signal" default. Nothing
  about where Triagent is used is dark, and the gradient and glows carried no information.
- *Terminal vernacular everywhere* (monospace UI, green on black): a costume. Only agents and CI meet Triagent in a
  terminal; people triage in a table.
- *A quiet landing page* (headline beside a small storyboard, then sections of text): correct and forgettable. It
  described the product where it could have handed it over.
- *Card dashboard* (rounded stat tiles, icon feature cards): shows six numbers on a screen and ranks nothing.

## Colour

Tokens are in `apps/web/src/styles/index.css`, named by role, with a value for each theme.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` / `--card` | `oklch(0.985 0.002 240)` / white | `oklch(0.17 0.01 240)` / `oklch(0.205 0.012 240)` | Page, and surfaces raised on it |
| `--foreground` | `oklch(0.22 0.015 240)` | `oklch(0.94 0.005 240)` | Text |
| `--muted-foreground`, `--border` | `oklch(0.47 0.015 240)`, `oklch(0.89 0.006 240)` | `oklch(0.74 0.012 240)`, white 12% | Secondary text, separators |
| `--primary` | `oklch(0.42 0.11 245)` | `oklch(0.78 0.1 245)` | The main action, links, selection, focus. Nothing static |
| `--sev-critical` … `--sev-low` | `#a4161a` `#a63f12` `#7c5c00` `#45657a` | `#ff7a75` `#f8995f` `#e6bb47` `#9dbccd` | Severity, always with its shape |
| `--st-*` | | | Triage status, always with its mark and word |
| `--destructive` | `oklch(0.5 0.19 27)` | `oklch(0.7 0.17 25)` | Errors and destructive actions, never the only signal |
| `--chart-1` … `--chart-3` | | | Chart series only: identity, with a legend and a table view |

Neutrals are tinted toward the action blue (hue 240). There is no accent colour: severity is the loud thing.

## Type

| Role | Family | Why this one |
|---|---|---|
| Text and display | Atkinson Hyperlegible Next | Made to keep similar letters apart. Findings are full of identifiers, and `l`, `I`, `1`, `O`, `0` must not be confused |
| Data and code | Atkinson Hyperlegible Mono | The same letterforms for paths, commits, diffs and counts, with a slashed zero |

**Scale:** 12 / 14 / 15 / 16 / 18 / 20 / 24, and 30 / 36 / 48 / 72 on the landing page only. Nothing below 12.
**Body:** interface text is 14 px (see exceptions). Text meant to be read — a finding, a note, a reviewer's summary,
landing-page prose — is 15 px or more, line-height 1.45–1.6, at most 80 characters a line.
Numbers in tables are tabular and right-aligned. Monospace is for code, paths, ids, commands and counts only.

## Layout

- **Idea in one sentence:** a rail to choose where you are, a list to scan, a panel beside it to read and decide.
- **Density:** compact. Used for long sittings, to compare and triage, with pointer and keyboard.
- **Spacing scale:** 4 8 12 16 24 32 48 64 96; `--spacing-field` (6) inside a field, `--spacing-form` (16) between
  fields, `--spacing-section` (24) between sections.
- **Alignment:** text, tables and forms are left-aligned. A page with a maximum width sits in the middle of the
  content area, so a wide screen has even margins; pages that use the full width (Issues, Tasks) start at its left.
- **Radius:** 4 px for marks and inline code; 6 px for controls; 8 px for tables, panels and dialogs. Nothing larger.
- **Elevation:** none for anything in the page. `shadow-xs` on a control that can be pressed. A real shadow only on
  what floats above the page: menus, popovers, dialogs, toasts.
- **Boxes:** a border groups a table or a form that is saved as one. Figures, short lists and prose sit on the page
  with a heading; no card inside a card.

```
+-----------+--------------------------------------+---------------------+
| Workspace | Issues                    10 issues  | ▲ Critical  Open    |
| Project   | [search] Severity Status Category    | User input is…      |
| Branch    |--------------------------------------| src/db/query.ts:41  |
|           | ▲ Critical  User input is…     Open  |                     |
| Overview  |   src/db/query.ts:41   ●●○           | Status [Open][…]    |
| Issues 10 | ◆ High      The handler…   Resolved  | Finding …           |
| Tasks  5  | ■ Medium    Session ids…       Open  | - old line          |
| …         | ● Low       Dates are…         Open  | + new line          |
+-----------+--------------------------------------+---------------------+
```

On a phone the rail becomes a bar of four destinations and "Menu" at the bottom, and an open finding replaces the
list.

## Motion

- **The one orchestrated moment:** the reviewers at the top of the landing page switching on one after another as
  the page opens, each finding flying to its row in the list. After that the switches are the reader's, and every
  flight answers one. Under reduced motion all three start on and nothing flies.
- **Started by the reader, never by scrolling:** the landing page's three agents working through a list.
- **Not animated:** anything in the app used all day — changing a status, opening a finding, switching tabs,
  filtering. Sections do not fade or slide in as the page scrolls. Nothing counts up.
- Menus, dialogs and toasts keep their short open and close transitions, because they explain where a thing came from.

## Voice

- **Tone:** plain and exact, said the way one developer would tell another. Says what will happen and what it costs.
  No exclamation marks, no jokes in errors.

| Concept | We call it | Not |
|---|---|---|
| One thing a review found | finding (in a review), issue (once it's in the list to triage) | comment, result, item |
| Running Open Code Review | review; "Start review" | run a scan, new review, job |
| One execution of a review | run | job, task |
| A group of issues the reviewer suggested fixing together | task | epic, group |
| Deciding what to do with issues | triage | manage, process |
| Declined on purpose | won't fix | dismissed, ignored |
| A model kept for reviews | favourite | preset, saved model |
| A person's or agent's credential | API token | key (keys are for model providers) |
| Where projects live | workspace | organisation, team (an organisation is a kind of workspace) |

Names come first and ids second: "Read and triage (`write`)", "PR #12 Redesign the checkout", never an id alone.

## Pattern decisions

- **Navigation:** a sidebar that stays visible; on a phone, a bottom bar with Overview, Issues, Tasks, Runs and
  Menu (the rest, by name).
- **Destructive actions:** things that can be put back (status, assignee, flags, a note's text) just happen. Bulk
  changes confirm with a toast that offers Undo. Deleting a note or revoking a token asks, naming the thing.
  Deleting a project, a branch's report or an account asks you to type its name. Destructive buttons are outlined in
  the danger colour with their own icon, set apart at the end of a row, never beside the main action.
- **Saving:** triage applies at once, a field at a time. Settings are saved explicitly, a section at a time, and
  never both on one screen.
- **Editing:** one issue or task in a side panel with the list still visible; settings on full pages; dialogs only
  for short, self-contained decisions.
- **Buttons:** one filled button for the main action of a view. Every other action has a border. A button with no
  border is allowed only for an icon everyone knows (close, show password) and for "Cancel" beside a filled button.
- **Collections:** tables and rows. Cards only on the landing page, for samples of the product.

## Deliberate exceptions

- **T1 — interface text is 14 px, secondary text 12 px.** Triagent is a dense tool used in long sittings: more rows
  on screen matters more than larger labels. Text that is read rather than scanned is 15 px or more.
- **I1 — three icons stand alone:** close (×), show or hide a password, and the sidebar toggle in the top bar. Each
  has an accessible name and a tooltip. The theme switch on the landing page is icon-only on a phone, where the
  header has no room for its label.
- **V4 — the landing page's section links are hidden on a phone.** The page is one column read top to bottom, and
  every section is reached by scrolling.
- **Landing page — the part about agents is dark in both themes.** Agents meet Triagent in a terminal, and that part
  of the page is a picture of one.
- **Landing page — the headline, the section headings over full-width demos and the closing call are centred.**
  They sit over something centred and as wide as the page. Prose beside a picture stays left-aligned.

## Default check

- [x] Nothing here is a first-wave default
- [x] Nothing here is a second-wave default chosen to avoid the first
- [x] Every colour and typeface has a reason that comes from the subject
- [x] With the logo removed, this could not be mistaken for another product
