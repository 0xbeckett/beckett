/** Pure renderers for compact Discord embeds. They receive aggregates, never source patches. */
import type { DiscordEmbed } from "../types.ts";
import type { SubscriptionUsage, UsageReset } from "../subscription-usage.ts";
import type { WorkTask } from "../task/store.ts";
import type { BranchCardSnapshot } from "../task/status.ts";

const GREEN = 0x2ea043;
const RED = 0xda3633;
const AMBER = 0xd29922;
const BLUE = 0x2f81f7;
const GRAY = 0x6e7681;

const PROVIDER_NAMES = {
  claude: "Claude",
  codex: "Codex",
} as const;

export function renderTaskEmbed(task: WorkTask): DiscordEmbed {
  // Discord caps one embed-field value at 1,024 characters. Eight compact rows stay comfortably
  // below that even when every stored title hits its 100-character maximum.
  const visible = task.branches.slice(0, 8);
  const lines = visible.map((branch) => {
    const title = branch.title.length > 72 ? `${branch.title.slice(0, 69)}...` : branch.title;
    return `**#${branch.ref}**  ${title}\n${branch.status}`;
  });
  if (task.branches.length > visible.length) lines.push(`...and ${task.branches.length - visible.length} more`);
  return {
    title: `#${task.number} - ${task.title}`,
    color: task.status === "done" ? GREEN : task.status === "cancelled" ? RED : BLUE,
    fields: [
      { name: "Status", value: task.status, inline: true },
      { name: "Branches", value: String(task.branches.length), inline: true },
      { name: "Work", value: lines.join("\n\n") || "No branches" },
    ],
    footer: { text: "Task numbers are stable; internal queue identifiers stay hidden." },
    timestamp: task.updatedAt,
  };
}

export function renderBranchEmbed(card: BranchCardSnapshot): DiscordEmbed {
  const fields: NonNullable<DiscordEmbed["fields"]> = [];
  if (card.changes) {
    fields.push(
      { name: "Changes", value: `+${card.changes.additions}  /  -${card.changes.deletions}`, inline: true },
      { name: "Files", value: String(card.changes.files), inline: true },
      { name: "Commits", value: String(card.changes.commits), inline: true },
    );
  } else {
    fields.push({ name: "Changes", value: "Waiting for a worktree", inline: true });
  }
  if (card.checks) {
    fields.push({
      name: "Checks",
      value: card.checks.total === 0
        ? "No checks configured"
        : `✓ ${card.checks.passed} passed   ◷ ${card.checks.pending} running   ✕ ${card.checks.failed} failed`,
    });
  } else {
    fields.push({
      name: "Checks",
      value: card.publication ? "Published without a pull request" : "Not published yet",
    });
  }
  if (card.review) {
    fields.push(
      { name: "Review", value: card.review.decision || "Review required", inline: true },
      { name: "Latest reviews", value: String(card.review.count), inline: true },
    );
  }
  if (card.discussion) fields.push({ name: "Conversation", value: String(card.discussion.comments), inline: true });

  const prState = card.pullRequest
    ? `${card.pullRequest.draft ? "DRAFT " : ""}${card.pullRequest.state} PR #${card.pullRequest.number}`
    : card.publication
      ? "PUBLISHED"
      : "LOCAL";
  return {
    title: `#${card.ref} - ${card.title}`,
    ...(card.pullRequest
      ? { url: card.pullRequest.url }
      : card.publication
        ? { url: card.publication.url }
        : {}),
    description: `Part of **#${card.taskNumber} - ${card.taskTitle}**\n${card.gitRef ? `\`${card.gitRef}\` · ` : ""}${prState}`,
    color: branchColor(card),
    fields,
    footer: { text: `Branch ${card.status} · aggregate Git status only` },
    timestamp: card.updatedAt,
  };
}

/** One compact card per subscription. Account identifiers and raw provider output never reach Discord. */
export function renderSubscriptionUsageEmbeds(usages: SubscriptionUsage[]): DiscordEmbed[] {
  return usages.map((usage) => {
    const provider = PROVIDER_NAMES[usage.provider];
    if (usage.status !== "ok") {
      return {
        title: `${provider} usage`,
        description: usage.status === "disconnected"
          ? "Not connected to a subscription on this host."
          : `Usage is temporarily unavailable (${reasonLabel(usage.reason)}).`,
        color: GRAY,
        footer: { text: "No account identifiers are shown." },
        timestamp: new Date(usage.observedAt).toISOString(),
      };
    }

    const fields = usage.windows.map((window) => ({
      name: window.label,
      value: [
        `**${formatPercent(window.remainingPercent)} left**`,
        usageBar(window.remainingPercent),
        `${formatPercent(window.usedPercent)} used${resetLabel(window.reset)}`,
      ].join("\n"),
      inline: true,
    }));
    if (usage.credits) {
      const creditLines = [usage.credits.unlimited ? "Unlimited" : "Metered"];
      if (usage.credits.balance !== undefined) creditLines.push(`Balance: ${usage.credits.balance}`);
      if (usage.credits.resetCount !== undefined) creditLines.push(`Resets: ${usage.credits.resetCount}`);
      fields.push({ name: "Credits", value: creditLines.join("\n"), inline: true });
    }
    const lowestRemaining = Math.min(...usage.windows.map((window) => window.remainingPercent));
    return {
      title: `${provider} usage`,
      description: usage.plan ? `**${usage.plan}** subscription` : "Connected subscription",
      color: lowestRemaining <= 20 ? RED : lowestRemaining <= 50 ? AMBER : GREEN,
      fields,
      footer: { text: "Remaining allowance · private to you" },
      timestamp: new Date(usage.observedAt).toISOString(),
    };
  });
}

function branchColor(card: BranchCardSnapshot): number {
  if (card.checks?.failed || card.review?.decision === "CHANGES_REQUESTED") return RED;
  if (card.pullRequest) {
    if (card.pullRequest.state === "MERGED") return GREEN;
    if (card.pullRequest.state === "CLOSED") return RED;
    if (card.checks?.pending || card.pullRequest.draft) return AMBER;
    return BLUE;
  }
  if (card.publication || card.status === "done") return GREEN;
  if (card.status === "review") return AMBER;
  if (card.source === "local") return GRAY;
  return BLUE;
}

function usageBar(remainingPercent: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, remainingPercent)) / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function resetLabel(reset: UsageReset): string {
  if (!reset) return "";
  if (reset.kind === "label") return ` · resets ${reset.text}`;
  const seconds = reset.at > 1_000_000_000_000 ? Math.floor(reset.at / 1_000) : Math.floor(reset.at);
  return ` · resets <t:${seconds}:R>`;
}

function reasonLabel(reason: SubscriptionUsage["reason"]): string {
  switch (reason) {
    case "not-connected": return "not connected";
    case "not-subscription": return "not a subscription login";
    case "timeout": return "provider timed out";
    case "malformed-response": return "provider response changed";
    case "no-usage-windows": return "no usage windows returned";
    case "command-failed":
    default: return "provider command failed";
  }
}
