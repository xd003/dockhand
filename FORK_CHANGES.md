# Fork Changes

What this fork adds on top of [upstream Dockhand](https://github.com/Finsys/dockhand). Only changes you can see or configure are listed; CI, tests and internal refactors are not.

## At a glance

| Area | What you get |
| --- | --- |
| [Stacks](#stacks) | Multiple ordered Compose files, read-only inspect mode, start services of undeployed stacks one by one, file browser filter |
| [Adopting existing projects](#adopting-existing-projects) | Manage untracked stacks in place, convert running projects to Git without stopping them |
| [Stack editor](#stack-editor) | File explorer for the whole stack directory, "push or keep local" choice on every Git edit, Compose validation everywhere |
| [Git stacks](#git-stacks) | One shared clone for many stacks, preview before creating, env overrides in the editor, failed deploys retry |
| [Hawser agents](#hawser-agents) | Stack files live on the agent host, live deploy output, safe removal |
| [Secret providers](#secret-providers) | Per-stack Infisical project/environment, Infisical/Doppler work without a selector, clearer 1Password errors |
| [Metrics and activity](#metrics-and-activity) | Per-environment switch for container stats, collection toggles that actually stop collection |
| [Sign-in and environments](#sign-in-and-environments) | OIDC from environment variables, no duplicate environments |
| [Phones and tablets](#phones-and-tablets) | Responsive layouts for every page and dialog |
| [Fixes](#fixes) | Rows don't jump while hovered, deploy history survives an unwritable log dir, DB migrations apply exactly once |
| [Environment variables](#environment-variables) | Every variable the fork adds, in one table |

## Stacks

- **Multiple Compose files, in order.** Internal and Git stacks can use several Compose files (base + overrides). Add, remove and reorder them in the stack settings; they are merged in that order, last file wins. Git stacks pick their files with **Browse repository**. Backups keep the whole set and restore redeploys all of it.
- **Inspect without editing.** Clicking a stack's name opens it read-only: settings, files, variables, tags and deploy history. Editing is behind the pencil button. View-only users are told an editor has to make changes.
- **Start services one by one.** Expanding a stack lists every service declared in its Compose files, even before the first deploy. Start a single service (plus its `depends_on`), e.g. bring up the database, restore it, then start the rest. Never-deployed Git stacks are cloned to read their services. Starting the whole stack later also creates the services that were never started.
- **Filter the file browser.** A filter box in the file browser narrows the current folder by name.

## Adopting existing projects

Untracked stacks (running in Docker, unknown to Dockhand) can be taken over without moving their files or stopping them.

- **Manage internally, in place.** Select the project's existing Compose file; Dockhand tracks it where it is, without copying, and loads the `.env` beside it. The stack is only tracked once you save. The file picker opens in the project's directory (on Hawser: inside the agent's `STACKS_DIR` or the project's own mounted directory). On Hawser, the project's containers must still carry their Compose labels.
- **Convert to Git, in place.** Put an external Compose project under Git without renaming it:
  - Pick the project's existing Compose file. Dockhand deploys in that directory: Git-tracked files replace same-path files, everything else (other files, bind-mount data) is kept. The directory is never moved, copied or deleted; the Git checkout itself stays under `GIT_REPOS_DIR`.
  - The explorer also shows the directory's own files, so you can fix them up before the first Git deploy.
  - Remote Docker host: Dockhand must see the same directory (e.g. an identical shared mount). A short-lived helper container checks this; otherwise conversion is refused.
  - Files gone? Leave the Compose file empty to deploy into Dockhand's own stack directory, or use **Manage internally → Compose file no longer exists?** to rebuild a Compose file from the running containers (image, command, environment, ports, mounts, networks, restart policy, healthcheck, dependencies; existing networks and volumes are reused).
  - If the deploy fails, everything created along the way is rolled back, including file changes.

## Stack editor

- **File explorer.** Browse a stack's whole directory, not just the Compose file. Open text files in tabs; create, upload, rename, move or delete files and folders. Binary files can be managed but not edited. Enable it per stack. Saving a Compose file with broken YAML is refused before anything is written.
- **You decide where every Git edit goes.** Files are labelled Git-tracked, untracked or local-only, and saving asks:

  | File | Choices |
  | --- | --- |
  | Tracked | **Push changes** (commit and push) or **Keep local only** (converts the stack to Internal, after confirmation) |
  | New or untracked | **Track & push** or **Keep local only** |
  | Ignored | Saved on the host without asking |

  Internal stacks save on the host and warn if the file changed since you opened it. When creating a stack from Git, the same choices are applied in one commit at deploy.
- **One layout for every stack.** Internal and Git stacks share the same editor, with the Compose and env file paths shown together; file tabs appear only for multi-file stacks.
- **Validate and copy from the Git editor.** Git stack drafts get the same **Validate** panel and copy button as internal stacks.
- **Add missing variables.** In an internal stack, **Add missing** creates entries for `${VAR}`s the Compose file uses but nothing defines. Plain values are appended to `.env` without touching existing lines; secrets stay in Dockhand.

## Git stacks

- **Shared repositories (opt-in).** Many stacks can deploy from one repository checkout instead of one clone each, with schedules and webhooks per repository. Choose the default for new stacks in **Settings → General** (or lock it with an [environment variable](#environment-variables)); existing stacks move over one at a time.
- **Preview before creating.** See the combined Compose configuration, load the repository's env values, and see which `${VAR}`s are still missing.
- **Environment overrides in the editor.** Variables are shown and edited next to the Compose file, stored as Dockhand overrides and applied on the next deploy.
- **Failed deploys retry.** A failed deploy marks the stack "Deploy failed", and the next sync redeploys the same commit with `--force-recreate`. **Always redeploy** also forces a recreate.
- **Editor and Graph tabs.** The Git stack settings dialog links to the stack's editor and graph views, and back.

## Hawser agents

- **Stack files stay on the agent.** For Hawser Standard and Edge, Compose files and everything beside them live on the agent's filesystem (`STACKS_DIR/<stack>` for new stacks), not in a copy on the Dockhand server.
  - Existing stacks migrate when an updated agent reconnects: the agent's files win, and the old copy is archived under `DATA_DIR/hawser-migration-archives`, not deleted.
  - Needs an agent that supports stack files. Offline or older agents can't deploy or edit files until connected or updated.
  - If the Docker host path differs from the agent's, mount the project directory into the Hawser container to manage it in place.
- **Live deploy output.** Pull and build output from Hawser Standard appears in the deploy window as it happens. Older agents keep the previous behaviour.
- **Safe removal.** Removing a Hawser stack "with files" deletes only the Compose/env files and unchanged Git files Dockhand put there. Bind-mount data, other files and adopted project directories are left alone.

## Secret providers

- **Infisical: one provider, many projects.** A provider only needs the host (pre-filled with Infisical Cloud) and credentials: an access token, or a Universal Auth client ID and secret. Each stack picks its project, environment and optional path from dropdowns; values set on the provider act as defaults. **Test connection** works without a default project.
- **Infisical and Doppler pull without a selector.** Binding the provider to a stack is enough to load its secrets at deploy, and the editor marks those keys **In vault**. Previously nothing was injected without a selector (and Doppler has no selector at all).
- **Selector follows the provider.** Unbinding a stack's provider, or switching to a provider of another type, removes the stack's selector so it isn't deployed into containers as a plain variable.
- **Clearer 1Password error.** When a 1Password Environment isn't shared with the service account, the error says so and where to grant access instead of "An unexpected error occurred".

## Metrics and activity

- **Turn off container stats per environment.** **Collect container metrics** in an environment's Activity tab stops all per-container CPU/memory/network/disk polling and hides those columns and tiles. Useful if another tool (e.g. Beszel) already collects them.
- **Collection toggles now work.** Turning off **Collect metrics** or **Collect activity** actually stops the collection (upstream only hid the charts or kept recording events).
- **Lock the toggles with environment variables.** See [Environment variables](#environment-variables). Stored settings are left untouched.

## Sign-in and environments

- **OIDC from environment variables.** Dockhand creates or updates the provider at startup; `OIDC_ENABLED=false` restores the previous auth settings. Role mappings made in the UI are kept. Variables are listed [below](#environment-variables).
- **No duplicate environments.** Adding a socket, TCP or Hawser connection to a Docker daemon that is already registered is refused instead of creating a second entry. `DOCKHAND_ALLOW_DUPLICATE_ENVS=true` turns the check off.

## Phones and tablets

- **Responsive layouts.** Every page and dialog adapts to small screens with touch-sized controls; tables become cards with the same details (including a stack's services), and editors keep a usable height.

## Fixes

- **Rows stop jumping.** On the stacks and containers lists, live stats don't re-sort the row under your pointer.
- **Deploy history survives log errors.** If the deploy-log directory isn't writable, the deploy is still recorded with its result (log marked truncated). Fresh containers also get correct ownership on that directory.
- **Database migrations apply exactly once.** Databases upgraded in a certain order missed some of the fork's migrations (e.g. "no such column: collect_container_metrics"), and re-dated migrations could run twice ("duplicate column"). Applied migrations are now tracked by content, so each one runs exactly once, whatever order it arrives in.

## Environment variables

**Sign-in**

| Variable | Effect |
| --- | --- |
| `OIDC_ENABLED` | `true` configures OIDC from the variables below at startup; `false` restores the previous auth settings |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | Required when `OIDC_ENABLED=true` |
| `OIDC_NAME`, `OIDC_SCOPES`, `OIDC_USERNAME_CLAIM`, `OIDC_EMAIL_CLAIM`, `OIDC_DISPLAY_NAME_CLAIM` | Optional provider name, scopes and claim mapping |
| `OIDC_ADMIN_CLAIM`, `OIDC_ADMIN_VALUE` | Optional, set together: users whose claim has this value become admins |

**Metrics and activity**

| Variable | Effect |
| --- | --- |
| `COLLECT_CONTAINER_ACTIVITY`, `COLLECT_SYSTEM_METRICS`, `COLLECT_CONTAINER_METRICS` | `true`/`false`: force the matching Activity-tab toggle (**Collect activity**, **Collect metrics**, **Collect container metrics**) for every environment and lock it in the UI |

**Git stacks**

| Variable | Effect |
| --- | --- |
| `DOCKHAND_GIT_CENTRALIZED_MODE` | Locks the default engine for new Git stacks: `true` = shared repositories, any other non-empty value = one clone per stack. Existing stacks are not migrated. Unset: chosen in **Settings → General** |
| `DOCKHAND_GIT_STACK_DEPLOY_TIMEOUT_MS` | Per-stack time limit when a shared repository deploys all of its stacks (default `1800000`, 30 min). A stack exceeding it is marked failed and the rest continue |
| `DOCKHAND_GIT_TRANSITION_DRAIN_TIMEOUT_MS` | How long migrating a stack to the other engine waits for its running syncs and deploys to finish before aborting (default `120000`, 2 min) |

**Environments**

| Variable | Effect |
| --- | --- |
| `DOCKHAND_ALLOW_DUPLICATE_ENVS` | `true`/`1` turns off the duplicate Docker daemon check when adding environments |
