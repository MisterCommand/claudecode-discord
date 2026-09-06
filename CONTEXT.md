# Discord Agent Control

This context defines how Discord-originated work is classified and governed by capability and access policy.

## Language

**Access Profile**:
The tools and access rules governing work executed in a Discord channel.
_Avoid_: Agent type, agent role

**Restricted Access Profile**:
The default Access Profile, which exposes the baseline capabilities and excludes protected resources.
_Avoid_: Regular Agent

**Admin Access Profile**:
The privileged Access Profile, which contains every Restricted capability, may expose additional capabilities, and permits protected resources.
_Avoid_: Admin Agent

**Admin Channel**:
A trusted Discord channel or thread whose own identity selects the Admin Access Profile and receives that work's output. Child threads do not inherit this classification from a parent channel.
_Avoid_: Inherited admin channel

**Admin Channel Registry**:
The trusted set of exact Discord channel and thread identities that select the Admin Access Profile. It is outside the authority of every agent.
_Avoid_: Agent-editable channel list

**Bot Configuration**:
Trusted, non-secret policy required for the bot to operate. It supplements deployment environment settings and remains outside every agent's authority.
_Avoid_: Project configuration, agent configuration

**Protected Repository**:
A remote source repository that the Restricted Access Profile must not target directly through recognized GitHub integration inputs, identified by an exact, case-insensitive owner and repository name. Incidental search results and unrecognized GitHub tool schemas are permitted.
_Avoid_: Blocked project, forbidden URL
