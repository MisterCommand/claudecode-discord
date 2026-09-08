import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BodyType, EmailMessage, ItemSchema, WellKnownFolderName,
  type AttachmentCollection, type EmailAddressCollection, type ExchangeService, type Item,
} from "ews-javascript-api";
import type { Config } from "../utils/config.js";
import {
  createEmailToolHandlers, emailCredentialEnvironmentOverrides, emailMcpServerForProfile,
  EwsEmailReader, resolveExchangeEmailConfig, type EmailReader, type ExchangeEmailConfig,
} from "./tools.js";

const exchangeConfig: ExchangeEmailConfig = {
  EWS_URL: "https://mail.example.com/EWS/Exchange.asmx",
  EWS_EMAIL: "admin@example.com",
  EWS_PASSWORD: "very-secret-password",
};

function addressCollection(...values: Array<{ Name: string; Address: string }>): EmailAddressCollection {
  return { Count: values.length, _getItem: (index: number) => values[index] } as EmailAddressCollection;
}

function attachments(): AttachmentCollection {
  const values = [{ Name: "report.pdf", ContentType: "application/pdf", Size: 2048, IsInline: false }];
  return { Count: values.length, _getItem: (index: number) => values[index] } as AttachmentCollection;
}

function item(overrides: Record<string, unknown> = {}): Item {
  return {
    Id: { UniqueId: "ews-item-id" },
    Subject: "Quarterly report",
    From: { Name: "Alex", Address: "alex@example.com" },
    Sender: { Name: "Alex", Address: "alex@example.com" },
    DateTimeReceived: { ToISOString: () => "2026-09-08T01:02:03.000Z" },
    IsRead: false,
    HasAttachments: true,
    Preview: "Preview text",
    ...overrides,
  } as unknown as Item;
}

function resultJson(result: Awaited<ReturnType<ReturnType<typeof createEmailToolHandlers>["listEmails"]>>) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("Exchange email configuration and profile exposure", () => {
  it("resolves only complete credentials and removes all three variables from the agent environment", () => {
    expect(resolveExchangeEmailConfig(exchangeConfig as Config)).toEqual(exchangeConfig);
    expect(resolveExchangeEmailConfig({ EWS_URL: undefined, EWS_EMAIL: undefined, EWS_PASSWORD: undefined } as Config))
      .toBeUndefined();
    expect(emailCredentialEnvironmentOverrides()).toEqual({
      EWS_URL: undefined,
      EWS_EMAIL: undefined,
      EWS_PASSWORD: undefined,
    });
  });

  it("exposes the MCP server only to configured Admin profiles", () => {
    expect(emailMcpServerForProfile("restricted", exchangeConfig as Config)).toBeUndefined();
    expect(emailMcpServerForProfile("admin", {} as Config)).toBeUndefined();
    expect(emailMcpServerForProfile("admin", exchangeConfig as Config)).toMatchObject({
      type: "sdk",
      name: "exchange_email",
    });
  });
});

describe("EWS read operations", () => {
  it("lists the Inbox with AQS, bounded paging, requested fields, and newest-first sorting", async () => {
    const findItems = vi.fn().mockResolvedValue({
      Items: [item()],
      TotalCount: 12,
      MoreAvailable: true,
      NextPageOffset: 7,
    });
    const reader = new EwsEmailReader(exchangeConfig, { FindItems: findItems } as unknown as ExchangeService);
    const result = await reader.listEmails({ query: "isread:false", limit: 5, offset: 2 });

    expect(findItems).toHaveBeenCalledOnce();
    const [folder, query, view] = findItems.mock.calls[0];
    expect(folder).toBe(WellKnownFolderName.Inbox);
    expect(query).toBe("isread:false");
    expect(view).toMatchObject({ PageSize: 5, Offset: 2 });
    expect(view.PropertySet.Contains(ItemSchema.Preview)).toBe(true);
    expect(view.OrderBy.Count).toBe(1);
    expect(result).toMatchObject({
      total_count: 12,
      has_more: true,
      next_offset: 7,
      messages: [{
        email_id: "ews-item-id",
        subject: "Quarterly report",
        is_read: false,
        has_attachments: true,
      }],
    });
  });

  it("binds one message as plain text and returns metadata without loading attachment contents", async () => {
    const bind = vi.spyOn(EmailMessage, "Bind").mockResolvedValue(item({
      InternetMessageId: "<message@example.com>",
      ToRecipients: addressCollection({ Name: "Admin", Address: "admin@example.com" }),
      CcRecipients: addressCollection(),
      Size: 4096,
      Body: { Text: "Full body" },
      Attachments: attachments(),
    }) as unknown as EmailMessage);
    const service = {} as ExchangeService;
    const reader = new EwsEmailReader(exchangeConfig, service);

    const result = await reader.getEmail("ews-item-id");

    expect(bind).toHaveBeenCalledOnce();
    const [boundService, id, propertySet] = bind.mock.calls[0];
    expect(boundService).toBe(service);
    expect(id.UniqueId).toBe("ews-item-id");
    expect(propertySet.RequestedBodyType).toBe(BodyType.Text);
    expect(propertySet.Contains(ItemSchema.Attachments)).toBe(true);
    expect(result).toMatchObject({
      body: "Full body",
      body_truncated: false,
      to: [{ name: "Admin", address: "admin@example.com" }],
      attachments: [{ name: "report.pdf", content_type: "application/pdf", size_bytes: 2048 }],
    });
  });
});

describe("email tool results", () => {
  it("labels successful results as untrusted mailbox content", async () => {
    const reader: EmailReader = {
      listEmails: vi.fn().mockResolvedValue({ messages: [], total_count: 0, has_more: false, next_offset: null }),
      getEmail: vi.fn(),
    };
    const handlers = createEmailToolHandlers(reader, exchangeConfig);
    const result = await handlers.listEmails({});
    expect(resultJson(result).mailbox_content_notice).toMatch(/Untrusted mailbox content/);
  });

  it("redacts every Exchange environment value from errors", async () => {
    const reader: EmailReader = {
      listEmails: vi.fn().mockRejectedValue(new Error(
        `failed at ${exchangeConfig.EWS_URL} for ${exchangeConfig.EWS_EMAIL} using ${exchangeConfig.EWS_PASSWORD}`,
      )),
      getEmail: vi.fn(),
    };
    const result = await createEmailToolHandlers(reader, exchangeConfig).listEmails({});
    const serialized = JSON.stringify(resultJson(result));
    expect(result.isError).toBe(true);
    expect(serialized).not.toContain(exchangeConfig.EWS_URL);
    expect(serialized).not.toContain(exchangeConfig.EWS_EMAIL);
    expect(serialized).not.toContain(exchangeConfig.EWS_PASSWORD);
  });
});
