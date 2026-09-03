import { describe, expect, it } from "vitest";
import { isScheduleManagementTool } from "./tools.js";

describe("schedule tool permission routing", () => {
  it("recognizes only the scheduler CRUD tools", () => {
    expect(isScheduleManagementTool("mcp__discord_scheduler__list_schedules")).toBe(true);
    expect(isScheduleManagementTool("mcp__discord_scheduler__create_schedule")).toBe(true);
    expect(isScheduleManagementTool("mcp__discord_scheduler__update_schedule")).toBe(true);
    expect(isScheduleManagementTool("mcp__discord_scheduler__delete_schedule")).toBe(true);
    expect(isScheduleManagementTool("create_schedule")).toBe(true);
    expect(isScheduleManagementTool("mcp__other__create_schedule")).toBe(false);
    expect(isScheduleManagementTool("Bash")).toBe(false);
  });
});
