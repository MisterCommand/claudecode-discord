import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleService } from "../../scheduler/service.js";
import { data, execute } from "./schedules.js";

afterEach(() => vi.restoreAllMocks());

function interaction(run: string | null = null, channelId = "123") {
  return {
    channelId,
    options: { getString: vi.fn().mockReturnValue(run) },
    editReply: vi.fn(),
  };
}

describe("/schedules", () => {
  it("keeps listing available without requiring the run option", () => {
    expect(data.toJSON().options).toEqual([
      expect.objectContaining({ name: "run", type: 3, required: false }),
    ]);
  });

  it("shows an empty state for the current channel", async () => {
    vi.spyOn(scheduleService, "getStatuses").mockReturnValueOnce([]);
    const command = interaction();
    await execute(command as never);
    expect(scheduleService.getStatuses).toHaveBeenCalledWith("123");
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("No schedules"));
  });

  it("renders valid and invalid schedules with next-run information", async () => {
    const nextRun = new Date("2030-01-01T00:00:00.000Z");
    vi.spyOn(scheduleService, "getStatuses").mockReturnValueOnce([
      {
        id: "daily", filePath: "daily.md", nextRun,
        definition: {
          id: "daily", filePath: "daily.md", sourceHash: "a", name: "Daily", description: "Digest",
          cron: "0 8 * * *", discordChannel: "123", enabled: true, prompt: "Prompt",
        },
      },
      { id: "broken", filePath: "broken.md", discordChannel: "123", nextRun: null, error: "cron is invalid" },
    ]);
    const command = interaction();
    await execute(command as never);
    const reply = command.editReply.mock.calls[0][0];
    const embed = reply.embeds[0].toJSON();
    expect(embed.fields).toHaveLength(2);
    expect(embed.fields?.[0].value).toContain("<t:1893456000:F>");
    expect(embed.fields?.[1].value).toContain("cron is invalid");
  });

  it.each(["daily", "Daily *summary*"])("starts a manual run using %s in the exact destination thread", async (identifier) => {
    const runNow = vi.spyOn(scheduleService, "runNow").mockResolvedValueOnce({
      id: "daily", filePath: "daily.md", sourceHash: "a", name: "Daily *summary*",
      cron: "0 8 * * *", discordChannel: "thread", enabled: false, prompt: "Prompt",
    });
    const getStatuses = vi.spyOn(scheduleService, "getStatuses");
    const command = interaction(identifier, "thread");
    await execute(command as never);
    expect(runNow).toHaveBeenCalledWith(identifier, "thread");
    expect(getStatuses).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith({
      content: "Starting **Daily \\*summary\\*** now. Results will appear in this channel or thread.",
      allowedMentions: { parse: [] },
    });
  });

  it("shows the cause and guidance when a manual run is rejected", async () => {
    const message = "No valid schedule exists in this channel. Use /schedules to check schedule IDs and validation errors.";
    vi.spyOn(scheduleService, "runNow").mockRejectedValueOnce(new Error(message));
    const command = interaction("missing");
    await execute(command as never);
    expect(command.editReply).toHaveBeenCalledWith({
      content: `Could not start the schedule: ${message}`,
      allowedMentions: { parse: [] },
    });
  });
});
