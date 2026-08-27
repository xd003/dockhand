# Fork Changes

User-facing improvements in this fork relative to [upstream Dockhand](https://github.com/Finsys/dockhand).

If you manage multiple Compose projects, remote Docker hosts, or Git-backed stacks, this fork adds:

- **Ordered Compose deployments**: Select multiple Compose files and deploy them in a predictable order, so overrides and base files are applied consistently.
- **Shared Git repositories**: Reuse one repository checkout across multiple stacks, with repository-wide schedules and webhooks. Existing stacks can be migrated one at a time.
- **Safer Git environment setup**: Preview the combined Compose configuration, load repository environment values when needed, and validate variables before a centralized stack is created.
- **Adopt existing Compose projects into Git**: Convert a Docker-discovered external project into a managed Git stack without changing its running project name. Services stay running while the existing directory, environment file, and relative bind data are preserved during the move.
- **Complete remote stack synchronization**: Send the full adopted or internal stack directory to Hawser environments, including sibling files and deletions, so remote files stay in sync with the deployment.
- **No duplicate Docker environments**: Detect when socket, direct TCP, and Hawser connections point to the same Docker daemon and prevent duplicate environment entries.
- **Stable live-sorted rows**: Keep stacks and containers from moving under the pointer while their live CPU, memory, disk, or network statistics refresh.
- **Read-only stack names**: Open an internal stack by clicking its name without entering edit mode; use the pencil control when you want to edit it.
- **Environment-based OIDC setup**: Configure OIDC with environment variables for repeatable deployments. Dockhand creates or updates the managed provider at startup and restores the previous authentication settings when this configuration is disabled.
- **Responsive layouts**: Use the application on smaller screens with mobile-first layouts and mobile-friendly forms and dialogs.
