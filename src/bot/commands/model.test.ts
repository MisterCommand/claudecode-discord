import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/config.js", () => ({
  getConfig: () => ({
    claude: {
      default_provider: "sonnet",
      providers: [
        { value: "sonnet", label: "Sonnet", default_model: "claude-sonnet-4-6" },
        { value: "kimi", label: "Moonshot Kimi", default_model: "kimi-k2" },
        { value: "glm", label: "GLM" },
      ],
    },
  }),
}));
vi.mock("../../db/channel-providers.js", () => ({
  channelProviders: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
}));

import { channelProviders } from "../../db/channel-providers.js";
import { data, execute } from "./model.js";

const editReply = vi.fn();
const get = vi.mocked(channelProviders.get);
const set = vi.mocked(channelProviders.set);
const clear = vi.mocked(channelProviders.clear);

function interaction(options: { provider?: string; reset?: boolean } = {}) {
  return {
    channelId: "123",
    options: {
      getString: (name: string) => (name === "provider" ? options.provider ?? null : null),
      getBoolean: (name: string) => (name === "reset" ? options.reset ?? false : null),
    },
    editReply,
  } as never;
}

beforeEach(() => {
  editReply.mockReset();
  get.mockReset();
  set.mockReset();
  clear.mockReset();
});

describe("/model", () => {
  it("registers every configured provider as a choice", () => {
    const options = data.toJSON().options ?? [];
    const providerOption = options.find((option) => option.name === "provider");
    const choices = providerOption && "choices" in providerOption ? providerOption.choices : undefined;
    expect(choices).toEqual([
      { name: "Sonnet", value: "sonnet" },
      { name: "Moonshot Kimi", value: "kimi" },
      { name: "GLM", value: "glm" },
    ]);
    expect(options.some((option) => option.name === "reset")).toBe(true);
  });

  it("stores the selected provider for the current channel", async () => {
    await execute(interaction({ provider: "kimi" }));
    expect(set).toHaveBeenCalledWith("123", "kimi");
    expect(clear).not.toHaveBeenCalled();
    const reply = editReply.mock.calls[0][0] as string;
    expect(reply).toContain("Moonshot Kimi");
    expect(reply).toContain("kimi-k2");
  });

  it("reports a channel override that is still configured", async () => {
    get.mockReturnValue("kimi");
    await execute(interaction());
    expect(set).not.toHaveBeenCalled();
    const reply = editReply.mock.calls[0][0] as string;
    expect(reply).toContain("Moonshot Kimi");
    expect(reply).toContain("an override for this channel");
  });

  it("reports the configured default when the channel has no override", async () => {
    get.mockReturnValue(undefined);
    await execute(interaction());
    const reply = editReply.mock.calls[0][0] as string;
    expect(reply).toContain("Sonnet");
    expect(reply).toContain("the configured default");
  });

  it("reports a stored provider that is no longer configured", async () => {
    get.mockReturnValue("removed");
    await execute(interaction());
    const reply = editReply.mock.calls[0][0] as string;
    expect(reply).toContain("Sonnet");
    expect(reply).toContain("`removed` is no longer configured");
  });

  it("clears the override even when a provider is supplied at the same time", async () => {
    await execute(interaction({ provider: "kimi", reset: true }));
    expect(clear).toHaveBeenCalledWith("123");
    expect(set).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0][0]).toContain("Cleared the provider override");
  });
});
