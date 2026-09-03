import { describe, expect, it, vi } from "vitest";
import { scheduleService } from "../../scheduler/service.js";
import { execute } from "./schedules.js";

describe("/schedules", () => {
  it("shows an empty state for the current channel", async () => {
    vi.spyOn(scheduleService, "getStatuses").mockReturnValueOnce([]);
    const editReply = vi.fn();
    await execute({ channelId: "123", editReply } as never);
    expect(scheduleService.getStatuses).toHaveBeenCalledWith("123");
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining("No schedules"));
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
    const editReply = vi.fn();
    await execute({ channelId: "123", editReply } as never);
    const reply = editReply.mock.calls[0][0];
    const embed = reply.embeds[0].toJSON();
    expect(embed.fields).toHaveLength(2);
    expect(embed.fields?.[0].value).toContain("<t:1893456000:F>");
    expect(embed.fields?.[1].value).toContain("cron is invalid");
  });
});
