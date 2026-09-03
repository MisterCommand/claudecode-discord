export interface ScheduleDefinition {
  id: string;
  filePath: string;
  sourceHash: string;
  name: string;
  description?: string;
  cron: string;
  discordChannel: string;
  enabled: boolean;
  timezone?: string;
  prompt: string;
}

export interface ScheduleValidationFailure {
  id: string;
  filePath: string;
  sourceHash: string;
  error: string;
  discordChannel?: string;
}

export interface ScheduleStatus {
  id: string;
  filePath: string;
  definition?: ScheduleDefinition;
  error?: string;
  discordChannel?: string;
  nextRun: Date | null;
}

export interface ScheduleCreateInput {
  name: string;
  description?: string;
  cron: string;
  discordChannel: string;
  enabled?: boolean;
  timezone?: string;
  prompt: string;
}

export interface ScheduleUpdateInput {
  name?: string;
  description?: string | null;
  cron?: string;
  discordChannel?: string;
  enabled?: boolean;
  timezone?: string | null;
  prompt?: string;
}
