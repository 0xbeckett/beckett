import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMailApi, MailMessage, MailMessageItem } from "./index.ts";
import { createAgentMailPoller, defaultMailListenerStateFile, mailSnippet } from "./listener.ts";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-mail-listener-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function item(messageId: string, from = "sender@example.com"): MailMessageItem {
  return {
    messageId, threadId: `thread-${messageId}`, labels: ["unread"], timestamp: "2026-07-14T00:00:00Z",
    from, to: ["0xbeckett@agentmail.to"], subject: `subject-${messageId}`,
  };
}

function fakeApi(messages: MailMessageItem[]): AgentMailApi {
  return {
    inboxes: {
      list: async () => ({ inboxes: [{ inboxId: "inbox-1", email: "0xbeckett@agentmail.to" }] }),
      create: async () => ({ inboxId: "created", email: "0xbeckett@agentmail.to" }),
      messages: {
        send: async () => ({ messageId: "sent", threadId: "sent-thread" }),
        list: async () => ({ messages }),
        get: async (_inboxId, messageId) => ({
          ...messages.find((candidate) => candidate.messageId === messageId)!,
          text: `body for ${messageId}\nwith another line`,
        }) as MailMessage,
      },
    },
  };
}

test("mail poller silently baselines old mail and emits exactly once for later IDs across restart", async () => {
  const dir = temp();
  const messages = [item("old")];
  const delivered: Array<{ messageId: string; from: string; subject: string; snippet: string }> = [];
  const opts = {
    api: fakeApi(messages),
    inboxStateFile: join(dir, "mail.json"),
    mailAddress: "0xbeckett@agentmail.to",
    stateFile: defaultMailListenerStateFile(dir),
    intervalMs: 0,
    onIncomingEmail: async (email: { messageId: string; from: string; subject: string; snippet: string }) => { delivered.push(email); },
  };
  const poller = createAgentMailPoller(opts);
  await poller.start();
  expect(delivered).toEqual([]);

  messages.unshift(item("new"));
  await poller.pollNow();
  await poller.pollNow(); // AgentMail redelivery/list repetition
  expect(delivered).toEqual([{
    messageId: "new", from: "sender@example.com", subject: "subject-new", snippet: "body for new with another line",
  }]);
  poller.stop();

  const afterRestart = createAgentMailPoller(opts);
  await afterRestart.start();
  await afterRestart.pollNow();
  expect(delivered).toHaveLength(1);
  afterRestart.stop();
});

test("poller does not turn outgoing mail into an inbound notification", async () => {
  const dir = temp();
  const messages = [item("old")];
  const delivered: string[] = [];
  const poller = createAgentMailPoller({
    api: fakeApi(messages), inboxStateFile: join(dir, "mail.json"), mailAddress: "0xbeckett@agentmail.to", stateFile: defaultMailListenerStateFile(dir), intervalMs: 0,
    onIncomingEmail: async (email) => { delivered.push(email.messageId); },
  });
  await poller.start();
  messages.unshift(item("outgoing", "Beckett <0xbeckett@agentmail.to>"));
  await poller.pollNow();
  expect(delivered).toEqual([]);
});

test("mail snippets are short text-first previews", () => {
  expect(mailSnippet({ ...item("m"), text: " x\n y " })).toBe("x y");
  expect(mailSnippet({ ...item("m"), html: "<p>Hello <b>there</b></p>" })).toBe("Hello there");
  expect(mailSnippet({ ...item("m"), text: "x".repeat(600) })).toHaveLength(500);
});
