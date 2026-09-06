# Use channel-derived access profiles

Discord work uses one of two fixed Access Profiles selected by the exact destination channel or thread ID: Restricted by default and Admin for IDs in the Admin Channel Registry. Admin is a strict capability superset of Restricted, threads do not inherit a parent's classification, scheduled work uses its destination channel, and each turn snapshots its profile; this keeps capability and output trust aligned with the Discord channel where the work executes.

## Consequences

Profile tool policy uses a global denylist plus Restricted-only denials. Restricted turns also deny recognized GitHub MCP calls that directly target an exact, case-insensitive Protected Repository; unscoped searches, non-targeting references, and unrecognized GitHub tool schemas remain allowed.
