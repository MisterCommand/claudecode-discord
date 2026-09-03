import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveTimezone, parseScheduleFile, scheduleIdFromName, serializeSchedule,
} from "./parser.js";

const valid = `---
name: Daily engineering summary
description: Summarize activity
cron: "0 8 * * *"
discord_channel: "123456789012345678"
enabled: true
timezone: Asia/Hong_Kong
---

Summarize code changes and pull requests.
`;

describe("schedule Markdown parser", () => {
  it("parses YAML front matter and the Markdown prompt", () => {
    const parsed = parseScheduleFile(path.join("schedules", "daily-summary.md"), valid);
    expect(parsed).toMatchObject({
      id: "daily-summary",
      name: "Daily engineering summary",
      description: "Summarize activity",
      cron: "0 8 * * *",
      discordChannel: "123456789012345678",
      enabled: true,
      timezone: "Asia/Hong_Kong",
      prompt: "Summarize code changes and pull requests.",
    });
    expect(parsed.sourceHash).toHaveLength(64);
  });

  it("supports CRLF and defaults enabled to true", () => {
    const source = `---\r\nname: Test\r\ncron: "15 9 * * 1"\r\ndiscord_channel: "123456789012345678"\r\n---\r\n\r\nPrompt\r\n`;
    expect(parseScheduleFile("test.md", source)).toMatchObject({ enabled: true, prompt: "Prompt" });
  });

  it("rejects malformed YAML and missing front matter", () => {
    expect(() => parseScheduleFile("test.md", "name: missing\nPrompt")).toThrow(/must begin with YAML front matter/);
    expect(() => parseScheduleFile("test.md", "---\nname: [\n---\nPrompt")).toThrow(/invalid YAML/);
  });

  it("rejects missing fields, unquoted channel IDs, and empty prompts", () => {
    expect(() => parseScheduleFile("test.md", "---\nname: Test\ncron: '* * * * *'\n---\nPrompt")).toThrow(/discord_channel/);
    expect(() => parseScheduleFile("test.md", "---\nname: Test\ncron: '* * * * *'\ndiscord_channel: 123456789012345678\n---\nPrompt")).toThrow(/quoted Discord channel ID/);
    expect(() => parseScheduleFile("test.md", "---\nname: Test\ncron: '* * * * *'\ndiscord_channel: '123456789012345678'\n---\n\n")).toThrow(/cannot be empty/);
  });

  it("rejects invalid cron expressions, six fields, and time zones", () => {
    expect(() => parseScheduleFile("test.md", valid.replace("0 8 * * *", "0 0 8 * * *"))).toThrow(/exactly five fields/);
    expect(() => parseScheduleFile("test.md", valid.replace("0 8 * * *", "99 8 * * *"))).toThrow(/invalid cron expression/);
    expect(() => parseScheduleFile("test.md", valid.replace("Asia/Hong_Kong", "Moon/Sea_of_Tranquility"))).toThrow(/valid IANA/);
  });

  it("rejects unsafe or non-lowercase filename IDs", () => {
    expect(() => parseScheduleFile("Daily Summary.md", valid)).toThrow(/filename must use only lowercase/);
    expect(() => parseScheduleFile("../bad name.md", valid)).toThrow(/filename must use only lowercase/);
  });

  it("serializes a parseable schedule", () => {
    const source = serializeSchedule({
      name: "Weekly review",
      cron: "0 17 * * 5",
      discordChannel: "123456789012345678",
      prompt: "Review the week.",
    });
    expect(parseScheduleFile("weekly-review.md", source)).toMatchObject({
      name: "Weekly review", enabled: true, prompt: "Review the week.", timezone: undefined,
    });
  });

  it("creates safe IDs and reports the effective host zone", () => {
    expect(scheduleIdFromName("  Café & Weekly Review  ")).toBe("cafe-weekly-review");
    expect(() => scheduleIdFromName("週報")).toThrow(/ASCII/);
    expect(effectiveTimezone()).toBeTruthy();
  });
});
