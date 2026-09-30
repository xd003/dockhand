# Fork Changes

User-facing improvements in this fork relative to [upstream Dockhand](https://github.com/Finsys/dockhand).

If you manage multiple Compose projects, remote Docker hosts, or Git-backed stacks, this fork adds:

## Compose and Git-backed stacks

- **Ordered Compose deployments:** Select multiple Compose files for a stack and control the order in which they are applied. Base files and overrides are combined predictably rather than depending on an implicit file order.
- **Shared Git repositories:** Manage multiple stacks from a single repository checkout instead of maintaining a separate clone for each stack. Schedules and webhooks can operate at repository level, and existing stacks can be migrated individually.
- **Safer Git stack setup:** Preview the combined Compose configuration before creating a centralized Git stack. Load repository environment values when needed and validate variables so missing values are caught during setup.
- **Git environment overrides:** Edit a Git-backed stack's environment overrides in the stack editor, alongside its Compose configuration.
- **Adopt existing Compose projects:** Bring a Docker-discovered external project under Git management without renaming its running project or stopping its services. **Convert to Git**, like **Manage internally**, can take the project's existing Compose file (browsed on Dockhand's filesystem locally, on the agent's for Hawser) and deploy in that directory: the Git checkout stays separate, tracked files replace same-path files there, and unrelated files and bind-mount data are kept. Redeploys, the stack workspace, and removal use the selected directory, which is never moved, copied, or deleted. On a direct remote Docker host, Dockhand first verifies the host resolves the selected path to the same files and otherwise blocks adoption. If the project's files are gone, leave the Compose file empty to deploy the repository to Dockhand's stack directory under the project's name, or use **Manage internally → Compose file no longer exists?** to start from a Compose file rebuilt from the running containers (services, environment, ports, mounts, networks and volumes reused by their Compose names) and save it like creating a stack.

## Stack file workspace

- **Browse and manage stack files:** Use the file explorer to inspect internal and Git-backed stack directories, including files beside the Compose file. Open text files in tabs; create, upload, rename, move, or delete files and folders from in-app dialogs. Binary files can be managed but are not edited as text.
- **Choose what happens when saving a Git file:** The workspace labels Git-tracked, untracked, and local-only files so the destination of an edit is explicit:
  - **New/untracked file:** Choose **Track & push** to add, commit, and push it, or **Keep local only** to save it on the stack host. A Hawser-local file is not included in Git sync.
  - **Git-tracked file:** Choose **Push changes** to commit and push the checkout edit, or **Keep local only**. The local choice requires confirmation to convert the stack to Internal.
  - **Internal stack:** Save file edits on the stack host. The editor checks for changes made since a file was opened before replacing it.
  - **New stack from Git:** **Deploy from Git** with the workspace enabled labels the checkout the same way and asks the same question on each save, but applies it when the stack deploys: **Push changes on deploy** / **Track & push on deploy** include the file in one commit, and **Keep local only** keeps a tracked edit out of Git for that deployment. Edits saved without a push choice never reach Git.
  - **Ignored files** save on the host without a prompt, since Git cannot track them.
- **Edit project files while converting to Git:** When **Convert to Git** enables the stack workspace, the explorer shows the selected project directory's own files next to the repository's, labeled Git-tracked or local-only. Local-only files and folders open on demand and can be edited, created, renamed, or deleted before **Deploy from Git**; those edits are applied to the directory just before Compose runs and restored if the conversion fails. Git files keep replacing same-path local files.
- **Hawser-owned stack files:** Hawser-standard and Hawser-edge keep their Compose files and host-only siblings on the agent filesystem, not in a Dockhand stack mirror. Dockhand retains Git checkouts for tracked files. Existing Dockhand-managed staging is preserved in a private migration archive when a capable agent reconnects; missing remote files block migration rather than being replaced by old staging. Offline or older agents cannot serve file actions or deployments until connected/upgraded. A Docker host bind path can differ from the agent-accessible stack directory; mount the directory into Hawser for in-place adoption.
- **Safe Hawser stack removal:** Removing a Hawser stack with its files deletes only the Compose/environment files and unchanged Git-published files in the agent-managed directory; bind-mount data, host-only files, and adopted project directories are left in place.

## Everyday administration

- **No duplicate Docker environments:** Detect when a socket, direct TCP connection, or Hawser connection points to an already-registered Docker daemon, avoiding duplicate environment entries for the same host.
- **Live Hawser Standard deploy output:** Pull and build output from a Hawser-standard agent streams into the deploy window, including the Git deploy window, as it happens instead of appearing only when Compose finishes. Needs an agent with Standard compose streaming; older agents keep the previous end-of-run output.
- **Stable live-sorted rows:** While you hover over a stack or container, live CPU, memory, disk, and network updates do not move the row out from under the pointer.
- **Read-only stack names:** Click an internal stack's name to inspect it without opening edit mode; use the pencil control when you intend to make changes.
- **Add missing variables when editing:** In the pencil editor, the Variables panel stays read-only but offers **Add missing** for `${VAR}`s the Compose file references and nothing defines. Added variables can be edited or removed until saved, and the footer offers **Save changes** and **Save and deploy** only while there are added variables to save. Git stacks save them as Dockhand overrides; internal stacks append non-secret ones to the `.env` file without touching existing lines, and keep secrets in Dockhand only.
- **Environment-based OIDC setup:** Supply OIDC configuration through environment variables for repeatable deployments. At startup Dockhand creates or updates the managed provider; disabling environment-based configuration restores the previous authentication settings.
- **Responsive layouts:** Navigate and manage stacks on smaller screens with mobile-friendly forms, dialogs, and layouts.
