# Auto-execute non-denied tools

Interactive Restricted and Admin turns both use `bypassPermissions`, so every tool that survives availability controls, deny rules, and pre-use hooks executes without Discord approval. This deliberately replaces the previous approve/deny interaction model and keeps approval behavior separate from Access Profile capability differences.

## Consequences

The obsolete approval state and interactions are removed. `AskUserQuestion` is hidden and its custom Discord UI is removed; Claude asks questions through normal responses, while the Stop control remains available.
