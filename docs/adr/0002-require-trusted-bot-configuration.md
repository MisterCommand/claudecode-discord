# Require trusted bot configuration

The bot requires a strict, versioned YAML file at `BOT_CONFIG_DIR/config.yaml` in addition to its environment settings. The configuration directory and file must be real, read-only filesystem objects outside `BASE_PROJECT_DIR`; missing, invalid, writable, or linked configuration prevents startup because channel classification and tool policy must remain outside every agent's authority.

## Consequences

The configuration is loaded once at startup with no hot reload. Version 1 contains exact Admin Channel IDs, Protected Repository identities, global tool denials, and Restricted-only tool denials; breaking existing environment-only deployments is accepted.
