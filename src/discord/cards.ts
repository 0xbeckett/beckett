/** Pure renderers for compact Discord embeds. They receive aggregates, never source patches. */
import type { DiscordEmbed } from "../types.ts";
import type { BranchCardSnapshot } from "../task/status.ts";

const GREEN = 0x2ea043;
const RED = 0xda3633;
const AMBER = 0xd29922;
const BLUE = 0x2f81f7;
const GRAY = 0x6e7681;

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
