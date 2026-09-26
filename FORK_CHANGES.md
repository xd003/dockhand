# Fork Changes

User-facing improvements in this fork relative to [upstream Dockhand](https://github.com/Finsys/dockhand).

If you manage multiple Compose projects, remote Docker hosts, or Git-backed stacks, this fork adds:

## Compose and Git-backed stacks

- **Ordered Compose deployments:** Select multiple Compose files for a stack and control the order in which they are applied. Base files and overrides are combined predictably rather than depending on an implicit file order.
- **Shared Git repositories:** Manage multiple stacks from a single repository checkout instead of maintaining a separate clone for each stack. Schedules and webhooks can operate at repository level, and existing stacks can be migrated individually.
- **Safer Git stack setup:** Preview the combined Compose configuration before creating a centralized Git stack. Load repository environment values when needed and validate variables so missing values are caught during setup.
- **Git environment overrides:** Edit a Git-backed stack's environment overrides in the stack editor, alongside its Compose configuration.
- **Adopt existing Compose projects:** Bring a Docker-discovered external project under Git management without renaming its running project or stopping its services. On Hawser, its existing agent-accessible Compose directory remains in place, preserving relative bind targets.

## Stack file workspace

- **Browse and manage stack files:** Use the file explorer to inspect internal and Git-backed stack directories, including files beside the Compose file. Open text files in tabs; create, upload, rename, move, or delete files and folders from in-app dialogs. Binary files can be managed but are not edited as text.
- **Choose what happens when saving a Git file:** The workspace labels Git-tracked, untracked, and local-only files so the destination of an edit is explicit:
  - **New/untracked file:** Choose **Track & push** to add, commit, and push it, or **Keep local only** to save it on the stack host. A Hawser-local file is not included in Git sync.
  - **Git-tracked file:** Choose **Push changes** to commit and push the checkout edit, or **Keep local only**. The local choice requires confirmation to convert the stack to Internal.
  - **Internal stack:** Save file edits on the stack host. The editor checks for changes made since a file was opened before replacing it.
- **Hawser-owned stack files:** Hawser-standard and Hawser-edge keep their Compose files and host-only siblings on the agent filesystem, not in a Dockhand stack mirror. Dockhand retains Git checkouts for tracked files. Existing Dockhand-managed staging is preserved in a private migration archive when a capable agent reconnects; missing remote files block migration rather than being replaced by old staging. Offline or older agents cannot serve file actions or deployments until connected/upgraded. A Docker host bind path can differ from the agent-accessible stack directory; mount the directory into Hawser for in-place adoption.
- **Safe Hawser stack removal:** Removing a Hawser stack with its files deletes only the Compose/environment files and unchanged Git-published files in the agent-managed directory; bind-mount data, host-only files, and adopted project directories are left in place.

## Everyday administration

- **No duplicate Docker environments:** Detect when a socket, direct TCP connection, or Hawser connection points to an already-registered Docker daemon, avoiding duplicate environment entries for the same host.
- **Stable live-sorted rows:** While you hover over a stack or container, live CPU, memory, disk, and network updates do not move the row out from under the pointer.
- **Read-only stack names:** Click an internal stack's name to inspect it without opening edit mode; use the pencil control when you intend to make changes.
- **Environment-based OIDC setup:** Supply OIDC configuration through environment variables for repeatable deployments. At startup Dockhand creates or updates the managed provider; disabling environment-based configuration restores the previous authentication settings.
- **Responsive layouts:** Navigate and manage stacks on smaller screens with mobile-friendly forms, dialogs, and layouts.
