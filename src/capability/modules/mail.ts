/**
 * Beckett v5 — the mail capability module (`src/capability/modules/mail.ts`)
 * =======================================================================================
 * The `beckett mail …` surface (Beckett's persistent AgentMail inbox, `src/mail/index.ts`),
 * normalized onto the common factory shape (V5 Phase 2). The handler body is the former
 * `cli/beckett.ts::runMail` moved verbatim; the CLI characterization suite pins its
 * observable behavior byte-for-byte.
 */

import { ActionClass, type Capability, type CapabilityDeps } from "../index.ts";
import {
  bootstrapInbox,
  createAgentMailApi,
  defaultMailStateFile,
  renderMessage,
  renderMessageTable,
  safeMailError,
} from "../../mail/index.ts";
import { fail, out, parse } from "../../cli/io.ts";

export function createMailCapability({ paths }: CapabilityDeps): Capability {
  async function runMail(sub: string | undefined, argv: string[]): Promise<never> {
    const help = [
      "usage: beckett mail <inbox|send|ls|read> [options]",
      "",
      "Manage Beckett's persistent AgentMail inbox.",
      "  inbox                              create or show the persistent inbox",
      "  send --to <addr> --subject <s> --body <b> [--body-stdin]",
      "                                     send from the persistent inbox",
      "  ls [--limit N] [--unread]          list recent messages",
      "  read <messageId>                   print headers and text-first body",
    ].join("\n");
    if (!sub || sub === "--help" || sub === "help" || sub === "-h") out(help);

    const apiKey = process.env.AGENTMAIL_API_KEY?.trim();
    if (!apiKey) fail("AGENTMAIL_API_KEY is not set — AgentMail mail commands require it in the runtime environment");

    const { _, flags } = parse(argv);
    try {
      const api = createAgentMailApi(apiKey);
      const inbox = await bootstrapInbox(api, defaultMailStateFile(paths.beckettDir));

      if (sub === "inbox") out({ inboxId: inbox.inboxId, address: inbox.address });

      if (sub === "send") {
        const to = typeof flags.to === "string" ? flags.to.trim() : "";
        const subject = typeof flags.subject === "string" ? flags.subject : "";
        if (!to || !subject) fail("usage: beckett mail send --to <addr> --subject <s> --body <b> [--body-stdin]");
        if (flags.body !== undefined && flags["body-stdin"] !== undefined) fail("use either --body or --body-stdin, not both");
        const body = flags["body-stdin"] ? await Bun.stdin.text() : typeof flags.body === "string" ? flags.body : "";
        if (!body) fail("mail send requires --body <text> or --body-stdin");
        const sent = await api.inboxes.messages.send(inbox.inboxId, { to, subject, text: body });
        out({ messageId: sent.messageId, threadId: sent.threadId });
      }

      if (sub === "ls") {
        const rawLimit = flags.limit === undefined ? 20 : Number(flags.limit);
        if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) fail("--limit must be an integer from 1 to 100");
        const messages = await api.inboxes.messages.list(inbox.inboxId, {
          limit: rawLimit,
          ...(flags.unread ? { labels: ["unread"] } : {}),
        });
        out(renderMessageTable(messages.messages));
      }

      if (sub === "read") {
        const messageId = _[0]?.trim();
        if (!messageId) fail("usage: beckett mail read <messageId>");
        out(renderMessage(await api.inboxes.messages.get(inbox.inboxId, messageId)));
      }

      fail(`unknown: beckett mail ${sub} (use inbox | send | ls | read)`);
    } catch (err) {
      fail(safeMailError(err, apiKey));
    }
  }

  return {
    // in-process: AgentMail SDK + ~/.beckett/mail.json durable inbox state
    id: "mail",
    summary: "Beckett's persistent AgentMail inbox",
    actionClass: ActionClass.FREE,
    cliHelp: "mail inbox|send|ls|read",
    cliVerbs: [
      {
        name: "mail",
        summary: "create/show the inbox, send, list, and read messages",
        usage: "beckett mail <inbox|send|ls|read> [options]",
        run: (argv) => runMail(argv[0], argv.slice(1)),
      },
    ],
    busCommands: [],
  };
}
