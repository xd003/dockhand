# Fork Changes

User-facing improvements in this fork relative to [upstream Dockhand](https://github.com/Finsys/dockhand).

If you manage multiple Compose projects, remote Docker hosts, or Git-backed stacks, this fork adds:

## Compose and Git-backed stacks

- **Ordered Compose deployments:** Select multiple Compose files for a stack and control the order in which they are applied. Base files and overrides are combined predictably rather than depending on an implicit file order.
- **Shared Git repositories:** Manage multiple stacks from a single repository checkout instead of maintaining a separate clone for each stack. Schedules and webhooks can operate at repository level, and existing stacks can be migrated individually.
- **Safer Git stack setup:** Preview the combined Compose configuration before creating a centralized Git stack. Load repository environment values when needed and validate variables so missing values are caught during setup.
- **Git environment overrides:** Edit a Git-backed stack's environment overrides in the stack editor, alongside its Compose configuration.
- **Adopt existing Compose projects:** Bring a Docker-discovered external project under Git management without renaming its running project or stopping its services. The adoption preserves the existing stack directory, environment file, and relative bind-mount data during the move.

## Stack file workspace

- **Browse and manage stack files:** Use the file explorer to inspect internal and Git-backed stack directories, including files beside the Compose file. Open text files in tabs; create, upload, rename, move, or delete files and folders from in-app dialogs. Binary files can be managed but are not edited as text.
- **Choose what happens when saving a Git file:** The workspace labels Git-tracked, untracked, and local-only files so the destination of an edit is explicit:
  - **New/untracked file:** Choose **Track & push** to add, commit, and push it, or **Keep local only** to save it on the host and add it to `.gitignore`. A local-only file is excluded from Git syncs.
  - **Git-tracked file:** Choose **Push changes** to commit and push the edit, or **Keep local only**. The local choice requires confirmation to **convert the stack to Internal**: Dockhand preserves the stack files, disables Git sync and webhooks for that stack, then saves the edit locally.
  - **Internal stack:** Save file edits locally without a Git decision. The editor checks for changes made since a file was opened before replacing it.
- **Complete remote stack synchronization:** For adopted or internal stacks on Hawser environments, synchronize the whole stack directory, including sibling files and deletions. Remote deployments receive the supporting files they need, not just the Compose file.

## Everyday administration

- **No duplicate Docker environments:** Detect when a socket, direct TCP connection, or Hawser connection points to an already-registered Docker daemon, avoiding duplicate environment entries for the same host.
- **Stable live-sorted rows:** While you hover over a stack or container, live CPU, memory, disk, and network updates do not move the row out from under the pointer.
- **Read-only stack names:** Click an internal stack's name to inspect it without opening edit mode; use the pencil control when you intend to make changes.
- **Environment-based OIDC setup:** Supply OIDC configuration through environment variables for repeatable deployments. At startup Dockhand creates or updates the managed provider; disabling environment-based configuration restores the previous authentication settings.
- **Responsive layouts:** Navigate and manage stacks on smaller screens with mobile-friendly forms, dialogs, and layouts.
