import type { BotFileConfig } from "../utils/config.js";

export type AccessProfile = "restricted" | "admin";

export interface AccessPolicySnapshot {
  profile: AccessProfile;
  disallowedTools: string[];
  protectedRepositories: string[];
}

export interface ProtectedRepositoryDenial {
  toolName: string;
  repositories: string[];
  reason: string;
}

const ALWAYS_HIDDEN_TOOLS = ["AskUserQuestion"];

// GitHub MCP actions whose current schemas directly identify a repository.
// Unknown actions intentionally fail open until their schemas are reviewed.
const REPOSITORY_SCOPED_GITHUB_ACTIONS = new Set([
  "add_comment_to_pending_review",
  "add_issue_comment_reaction",
  "add_issue_comment",
  "add_issue_reaction",
  "add_pull_request_review_comment",
  "add_pull_request_review_comment_reaction",
  "add_reply_to_pull_request_comment",
  "add_sub_issue",
  "actions_get",
  "actions_get_job_logs",
  "actions_list",
  "actions_run_trigger",
  "assign_copilot_to_issue",
  "assign_copilot_to_issue_with_intent",
  "cancel_workflow_run",
  "create_branch",
  "create_issue",
  "create_or_update_file",
  "create_pull_request",
  "create_pull_request_review",
  "create_pull_request_with_copilot",
  "create_repository_ruleset",
  "custom_properties_read",
  "custom_properties_write",
  "delete_file",
  "delete_pending_review",
  "delete_pending_pull_request_review",
  "delete_repository",
  "delete_workflow_run_logs",
  "discussion_comment_write",
  "download_workflow_run_artifact",
  "find_duplicate",
  "fork_repository",
  "get_commit",
  "get_code_quality_finding",
  "get_code_scanning_alert",
  "get_dependabot_alert",
  "get_discussion",
  "get_discussion_comments",
  "get_file_contents",
  "get_file_blame",
  "get_issue",
  "get_issue_comments",
  "get_job_logs",
  "get_label",
  "get_latest_release",
  "get_pull_request",
  "get_pull_request_comments",
  "get_pull_request_files",
  "get_pull_request_reviews",
  "get_pull_request_status",
  "get_release_by_tag",
  "get_repository_tree",
  "get_secret_scanning_alert",
  "get_tag",
  "get_workflow",
  "get_workflow_job",
  "get_workflow_job_logs",
  "get_workflow_run",
  "get_workflow_run_logs",
  "get_workflow_run_usage",
  "issue_dependency_read",
  "issue_dependency_write",
  "issue_read",
  "issue_write",
  "list_branches",
  "list_code_scanning_alerts",
  "list_commits",
  "list_discussion_categories",
  "list_discussions",
  "list_issue_fields",
  "list_issue_types",
  "list_issues",
  "list_labels",
  "list_pull_requests",
  "list_releases",
  "list_repository_collaborators",
  "list_repository_security_advisories",
  "list_secret_scanning_alerts",
  "list_tags",
  "list_workflow_jobs",
  "list_workflow_run_artifacts",
  "list_workflow_runs",
  "list_workflows",
  "label_write",
  "manage_repository_notification_subscription",
  "merge_pull_request",
  "pull_request_read",
  "pull_request_review_write",
  "pull_request_write",
  "push_files",
  "remove_sub_issue",
  "reprioritize_sub_issue",
  "request_copilot_review",
  "request_pull_request_reviewers",
  "repository_ruleset_read",
  "resolve_review_thread",
  "rerun_failed_jobs",
  "rerun_workflow_run",
  "run_workflow",
  "search_code",
  "search_commits",
  "search_issues",
  "search_pull_requests",
  "semantic_issue_similarity_search",
  "semantic_issues_search",
  "set_issue_fields",
  "star_repository",
  "sub_issue_write",
  "submit_pending_pull_request_review",
  "unresolve_review_thread",
  "unstar_repository",
  "update_issue",
  "update_issue_assignees",
  "update_issue_body",
  "update_issue_labels",
  "update_issue_milestone",
  "update_issue_state",
  "update_issue_title",
  "update_issue_type",
  "update_pull_request",
  "update_pull_request_branch",
  "update_pull_request_body",
  "update_pull_request_draft_state",
  "update_pull_request_state",
  "update_pull_request_title",
]);

const QUERY_SCOPED_GITHUB_ACTIONS = new Set(["search_code", "search_commits", "search_issues", "search_pull_requests"]);

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function profileLabel(profile: AccessProfile): "Restricted" | "Admin" {
  return profile === "admin" ? "Admin" : "Restricted";
}

export function resolveAccessProfile(channelId: string, config: BotFileConfig): AccessProfile {
  return config.access.admin_channels.includes(channelId) ? "admin" : "restricted";
}

export function snapshotAccessPolicy(channelId: string, config: BotFileConfig): AccessPolicySnapshot {
  const profile = resolveAccessProfile(channelId, config);
  const profileDenials = profile === "restricted" ? config.tools.restricted_denied : [];
  return {
    profile,
    disallowedTools: unique([...ALWAYS_HIDDEN_TOOLS, ...config.tools.denied, ...profileDenials]),
    protectedRepositories: [...config.access.protected_repositories],
  };
}

export function normalizeRepository(value: string): string | undefined {
  let candidate = value.trim();
  if (!candidate) return undefined;

  const scpMatch = candidate.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (scpMatch) candidate = scpMatch[1];
  else {
    try {
      const withProtocol = /^github\.com\//i.test(candidate) ? `https://${candidate}` : candidate;
      const url = new URL(withProtocol);
      if (url.hostname.toLowerCase() !== "github.com") return undefined;
      candidate = url.pathname.replace(/^\/+/, "");
    } catch {
      // Plain owner/repository values are handled below.
    }
  }

  candidate = candidate.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = candidate.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) return undefined;
  return `${parts[0]}/${parts[1]}`;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined;
}

function directRepositoryTargets(action: string, input: Record<string, unknown>): string[] {
  const targets: string[] = [];
  const pairs: Array<[string, string]> = [
    ["owner", "repo"],
    ["item_owner", "item_repo"],
    ["related_owner", "related_repo"],
    ["subject_owner", "subject_repo"],
    ["target_owner", "target_repo"],
  ];
  for (const [ownerKey, repoKey] of pairs) {
    const owner = stringField(input, ownerKey);
    const repository = stringField(input, repoKey);
    if (owner && repository) {
      const normalized = normalizeRepository(`${owner}/${repository}`);
      if (normalized) targets.push(normalized);
    }
  }

  for (const key of ["repository", "repository_url", "repo_url"]) {
    const value = stringField(input, key);
    const normalized = value ? normalizeRepository(value) : undefined;
    if (normalized) targets.push(normalized);
  }

  const repository = stringField(input, "repo");
  if (repository && (repository.includes("/") || /github\.com[:/]/i.test(repository))) {
    const normalized = normalizeRepository(repository);
    if (normalized) targets.push(normalized);
  }

  if (QUERY_SCOPED_GITHUB_ACTIONS.has(action)) {
    const query = stringField(input, "query");
    if (query) {
      const qualifier = /(?:^|\s)repo:(?:"([^"]+)"|'([^']+)'|(\S+))/gi;
      let match: RegExpExecArray | null;
      while ((match = qualifier.exec(query)) !== null) {
        const value = match[1] ?? match[2] ?? match[3];
        if (!value) continue;
        const normalized = normalizeRepository(value);
        if (normalized) targets.push(normalized);
      }
    }
  }

  return unique(targets);
}

export function evaluateProtectedRepositoryAccess(
  policy: AccessPolicySnapshot,
  toolName: string,
  toolInput: unknown,
): ProtectedRepositoryDenial | undefined {
  if (policy.profile !== "restricted" || !toolName.startsWith("mcp__github__")) return undefined;
  const action = toolName.slice("mcp__github__".length);
  if (!REPOSITORY_SCOPED_GITHUB_ACTIONS.has(action)) return undefined;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return undefined;

  const protectedSet = new Set(policy.protectedRepositories.map((repository) => repository.toLowerCase()));
  const repositories = directRepositoryTargets(action, toolInput as Record<string, unknown>)
    .filter((repository) => protectedSet.has(repository.toLowerCase()));
  if (!repositories.length) return undefined;

  return {
    toolName,
    repositories,
    reason: `GitHub MCP cannot target protected repository ${repositories.join(", ")}.`,
  };
}

export function writeToolDenialAudit(
  channelId: string,
  profile: AccessProfile,
  denial: ProtectedRepositoryDenial,
): void {
  for (const repository of denial.repositories) {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "tool_denied",
      channel_id: channelId,
      access_profile: profile,
      tool: denial.toolName,
      repository,
    })}\n`);
  }
}
