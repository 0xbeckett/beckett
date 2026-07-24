/**
 * Beckett v6 — the mail extension (`src/capability/modules/mail.ts`)
 * =======================================================================================
 * The `beckett mail …` surface (Beckett's persistent AgentMail inbox, `src/mail/index.ts`) on
 * the v6 extension contract (Phase 4, docs/v6-architecture.md §6). Two entrypoints:
 *   - the CLI verb keeps its historical body byte-for-byte — the bare/`--help` help print, the
 *     `--body-stdin` read, the `AGENTMAIL_API_KEY` gate, and the single `catch → fail(safeMailError)`
 *     that redacts the key from any leaked error (the CLI characterization suite pins it), and
 *   - the `mail.*` capabilities are the v6 dispatch surface: zod-validated args in, an
 *     {@link ExtensionResult} out — never `out`/`fail`. Its catch runs the error through
 *     {@link safeMailError} too, so the key never lands in an `ExtensionResult.error`.
 *
 * `mail.send` acts OUTWARD (an email leaves the box), so it carries a non-FREE per-capability
 * posture (forward ext.invoke catalog metadata) and an authenticated-origin backstop — while the
 * manifest action-class stays FREE so the {@link asCapability} projection the v5 spine registers
 * is byte-identical. `createMailCapability` remains the projection for the v5 factory table.
 */

import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import {
  bootstrapInbox,
  createAgentMailApi,
  defaultMailStateFile,
  renderMessage,
  renderMessageTable,
  safeMailError,
} from "../../mail/index.ts";
import { fail, out, parse } from "../../cli/io.ts";

/**
 * The one operation core BOTH entrypoints call — the CLI verb wrapper (adapting throws to the
 * historical `fail(safeMailError)`) and the `mail.*` invoke (adapting them to `ok:false`):
 * bootstrap the persistent inbox and run the action, RETURNING structured data or THROWING the
 * historical validation message (never `out`/`fail`).
 */
async function mailAction(
  action: "inbox" | "send" | "ls" | "read",
  params: { to?: string; subject?: string; body?: string; limit?: number; unread?: boolean; messageId?: string },
  apiKey: string,
  beckettDir: string,
): Promise<unknown> {
  const api = createAgentMailApi(apiKey);
  const inbox = await bootstrapInbox(api, defaultMailStateFile(beckettDir));
  switch (action) {
    case "inbox":
      return { inboxId: inbox.inboxId, address: inbox.address };
    case "send": {
      const to = (params.to ?? "").trim();
      const subject = params.subject ?? "";
      if (!to || !subject) throw new Error("usage: beckett mail send --to <addr> --subject <s> --body <b> [--body-stdin]");
      const body = params.body ?? "";
      if (!body) throw new Error("mail send requires --body <text> or --body-stdin");
      const sent = await api.inboxes.messages.send(inbox.inboxId, { to, subject, text: body });
      return { messageId: sent.messageId, threadId: sent.threadId };
    }
    case "ls": {
      const rawLimit = params.limit === undefined ? 20 : params.limit;
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw new Error("--limit must be an integer from 1 to 100");
      const messages = await api.inboxes.messages.list(inbox.inboxId, {
        limit: rawLimit,
        ...(params.unread ? { labels: ["unread"] } : {}),
      });
      return renderMessageTable(messages.messages);
    }
    case "read": {
      const messageId = params.messageId?.trim();
      if (!messageId) throw new Error("usage: beckett mail read <messageId>");
      return renderMessage(await api.inboxes.messages.get(inbox.inboxId, messageId));
    }
  }
}

const InboxArgs = z.object({});
const SendArgs = z.object({
  to: z.string().trim().min(1, "mail.send needs a `to` address"),
  subject: z.string().trim().min(1, "mail.send needs a subject"),
  body: z.string().min(1, "mail.send needs a body"),
});
const ListArgs = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  unread: z.boolean().optional(),
});
const ReadArgs = z.object({
  messageId: z.string().trim().min(1, "mail.read needs a messageId"),
});

export const createMailExtension: ExtensionFactory = ({ paths }): Extension => {
  // The former `cli/beckett.ts::runMail`, observable behavior unchanged: ONLY the help print,
  // the env gate, --body-stdin, and the single catch → fail(safeMailError) live here — the
  // inbox/send/ls/read semantics come from the shared {@link mailAction} core, so the two
  // entrypoints cannot drift.
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
      if (sub === "inbox") out(await mailAction("inbox", {}, apiKey, paths.beckettDir));

      if (sub === "send") {
        // Surface-specific: only the CLI reads stdin; the core validates to/subject/body.
        if (flags.body !== undefined && flags["body-stdin"] !== undefined) fail("use either --body or --body-stdin, not both");
        const body = flags["body-stdin"] ? await Bun.stdin.text() : typeof flags.body === "string" ? flags.body : "";
        out(await mailAction("send", {
          to: typeof flags.to === "string" ? flags.to : "",
          subject: typeof flags.subject === "string" ? flags.subject : "",
          body,
        }, apiKey, paths.beckettDir));
      }

      if (sub === "ls") {
        out(await mailAction("ls", {
          limit: flags.limit === undefined ? undefined : Number(flags.limit),
          unread: Boolean(flags.unread),
        }, apiKey, paths.beckettDir));
      }

      if (sub === "read") out(await mailAction("read", { messageId: _[0] }, apiKey, paths.beckettDir));

      fail(`unknown: beckett mail ${sub} (use inbox | send | ls | read)`);
    } catch (err) {
      fail(safeMailError(err, apiKey));
    }
  }

  return {
    manifest: {
      // in-process: AgentMail SDK + ~/.beckett/mail.json durable inbox state
      id: "mail",
      version: "1.0.0",
      summary: "Beckett's persistent AgentMail inbox",
      // FREE at the manifest layer for the byte-identical projection; mail.send acts outward and
      // carries its own non-FREE per-capability posture below.
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch ---
    capabilities: [
      {
        id: "mail.inbox",
        description:
          "Create or show Beckett's persistent email inbox (its address + id). Use to find out " +
          "the address to give someone, or to confirm the inbox exists.",
        input: InboxArgs,
        examples: ["what's your email address?"],
      },
      {
        id: "mail.send",
        description:
          "Send an email from Beckett's persistent inbox to an address, with a subject and body. " +
          "Acts outward (a real email leaves), so reach for it only when explicitly asked to email " +
          "someone.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: SendArgs,
        examples: ["email alice@example.com the summary with subject 'weekly update'"],
      },
      {
        id: "mail.list",
        description:
          "List recent messages in the inbox (optionally only unread). A read — use to check for " +
          "new mail or find a message to read.",
        input: ListArgs,
        examples: ["any new email?", "show my unread messages"],
      },
      {
        id: "mail.read",
        description:
          "Read one message by id — headers plus the text-first body. Use after listing to open a " +
          "specific message.",
        input: ReadArgs,
        examples: ["read the message from alice"],
      },
    ],
    invoke: async (call) => {
      const apiKey = process.env.AGENTMAIL_API_KEY?.trim();
      if (!apiKey) {
        return { ok: false, error: "AGENTMAIL_API_KEY is not set — AgentMail mail commands require it in the runtime environment" };
      }
      try {
        switch (call.capabilityId) {
          case "mail.inbox":
            return { ok: true, data: await mailAction("inbox", {}, apiKey, paths.beckettDir) };
          case "mail.send": {
            if (!call.origin?.userId) return { ok: false, error: "mail: sending needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof SendArgs>;
            return { ok: true, data: await mailAction("send", { to: a.to, subject: a.subject, body: a.body }, apiKey, paths.beckettDir) };
          }
          case "mail.list": {
            const a = call.args as z.infer<typeof ListArgs>;
            return { ok: true, data: await mailAction("ls", { limit: a.limit, unread: a.unread }, apiKey, paths.beckettDir) };
          }
          case "mail.read": {
            const a = call.args as z.infer<typeof ReadArgs>;
            return { ok: true, data: await mailAction("read", { messageId: a.messageId }, apiKey, paths.beckettDir) };
          }
          default:
            return { ok: false, error: `mail: unknown capability "${call.capabilityId}"` };
        }
      } catch (err) {
        // Redact the API key from any leaked error, exactly the CLI's guarantee.
        return { ok: false, error: safeMailError(err, apiKey) };
      }
    },

    // --- v5 facets, carried through unchanged ---
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
};

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createMailCapability(deps: CapabilityDeps): Capability {
  return asCapability(createMailExtension(deps));
}
