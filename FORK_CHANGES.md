# Fork Changes

User-facing changes in this fork relative to [upstream Dockhand](https://github.com/Finsys/dockhand).

- **Ordered Compose files**: Select and deploy multiple Compose files in a defined order.
- **Centralized Git engine**: Share repository clones across stacks, with repository-level schedules and webhooks, per-stack fan-out, and opt-in per-stack migration.
- **Centralized Git environment handling**: Preview ordered Compose files, populate repository environment values on demand, and validate variables during centralized stack creation.
- **Adopted stack directory sync**: Deploy the complete adopted or internal stack directory to Hawser environments, including sibling files and deletions.
- **Unique Docker environments**: Prevent duplicate environments across socket, agent, and direct TCP connection types.
- **Stable stack rows while hovering**: Pause live stats refresh while the pointer is over the stacks table so rows do not move under the cursor.
- **Read-only stack name display**: Open an internal stack from its name without entering edit mode; editing remains available through the pencil control.
- **Responsive layouts**: Add mobile-first layouts across the application for smaller screens.

CI, tests, dependency updates, and internal maintenance changes are intentionally excluded.
