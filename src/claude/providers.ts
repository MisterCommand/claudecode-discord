import type { ClaudeConfig, ClaudeProvider } from "../utils/config.js";

export function claudeEnvironmentOverrides(provider: ClaudeProvider): NodeJS.ProcessEnv {
  return {
    // Always claimed, so a value exported in the parent shell can never override config.yaml.
    // Leaving these undefined preserves the host `claude login` (OAuth) credentials:
    // Node omits undefined values from the child process environment.
    ANTHROPIC_API_KEY: provider.api_key,
    ANTHROPIC_BASE_URL: provider.base_url,
    // Claude Code tunables are overridden only when the provider sets them, so an operator who
    // exports them for interactive CLI use keeps that value.
    ...(provider.subagent_model ? { CLAUDE_CODE_SUBAGENT_MODEL: provider.subagent_model } : {}),
    ...(provider.effort_level ? { CLAUDE_CODE_EFFORT_LEVEL: provider.effort_level } : {}),
  };
}

export function resolveClaudeProvider(claude: ClaudeConfig, selected: string | undefined): ClaudeProvider {
  return claude.providers.find((provider) => provider.value === selected)
    ?? claude.providers.find((provider) => provider.value === claude.default_provider)
    ?? claude.providers[0];
}
