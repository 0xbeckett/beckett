/** Pure renderers for compact Discord embeds. They receive aggregates, never source patches. */
import type { DiscordButton, DiscordEmbed } from "../types.ts";
import type { BranchCardSnapshot, TaskCardBranchSnapshot, TaskCardSnapshot } from "../task/status.ts";
import type { TaskBranchStatus } from "../task/store.ts";
import { componentId } from "./interactions.ts";

const GREEN = 0x2ea043;
const RED = 0xda3633;
const AMBER = 0xd29922;
const BLUE = 0x2f81f7;
const GRAY = 0x6e7681;

/** The real controls carried with a branch card; link controls and interactions share one row. */
export function branchCardButtons(card: BranchCardSnapshot): DiscordButton[] {
  const buttons: DiscordButton[] = [];
  if (card.pullRequest) buttons.push({ label: "Open PR", url: card.pullRequest.url });
  else if (card.publication) buttons.push({ label: "Open repository", url: card.publication.url });
  if (card.status === "done" && card.pullRequest?.state === "OPEN") {
    buttons.push({ label: "Merge branch", customId: componentId("merge", card.ref) });
  }
  if (card.status !== "cancelled") {
    buttons.push({ label: "Cancel branch", customId: componentId("cancel", card.ref), danger: true });
  }
  // The interaction channel (not this card's author/location) is the workspace target.
  buttons.push({ label: "Attach to thread", customId: componentId("attach", String(card.taskNumber)) });
  return buttons;
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

// ── task card (#104): one self-editing embed per task, machine state only ──────────────────────

/** Human label for each lifecycle state the card reflects. */
const BRANCH_STATE_LABEL: Record<TaskBranchStatus, string> = {
  ready: "Queued",
  waiting: "Waiting on dependencies",
  designing: "Designing",
  approval: "Awaiting design approval",
  running: "Running",
  review: "In review",
  blocked: "Stalled",
  done: "Done",
  cancelled: "Cancelled",
};

/** A dot per state so the card scans at a glance without depending on field colour. */
const BRANCH_STATE_ICON: Record<TaskBranchStatus, string> = {
  ready: "⚪",
  waiting: "⚪",
  designing: "🔵",
  approval: "🟡",
  running: "🔵",
  review: "🟡",
  blocked: "🔴",
  done: "🟢",
  cancelled: "⚫",
};

/**
 * The whole task as one embed: title, aggregate colour, and a field per branch carrying its
 * lifecycle state and — once work has produced them — the artifact and preview links. This is
 * machine state, edited in place; it never speaks in Beckett's voice.
 */
export function renderTaskCardEmbed(snapshot: TaskCardSnapshot): DiscordEmbed {
  const fields: NonNullable<DiscordEmbed["fields"]> = snapshot.branches.map((branch) => ({
    name: truncate(`#${branch.ref} · ${branch.title}`, 240),
    value: branchLine(branch),
  }));
  if (fields.length === 0) fields.push({ name: "Branches", value: "No branches yet" });
  return {
    title: truncate(`#${snapshot.number} - ${snapshot.title}`, 240),
    description: taskStateLine(snapshot),
    color: taskCardColor(snapshot),
    fields,
    footer: { text: "Live task card · updates in place" },
    timestamp: snapshot.updatedAt,
  };
}

/** The card's controls: per-branch link/merge/cancel plus one task-level attach. */
export function taskCardButtons(snapshot: TaskCardSnapshot): DiscordButton[] {
  const buttons: DiscordButton[] = [];
  for (const branch of snapshot.branches) {
    if (branch.artifact) {
      buttons.push({
        label: branch.artifact.kind === "pull_request"
          ? `Open PR${branch.pullRequestNumber ? ` #${branch.pullRequestNumber}` : ""}`
          : "Open repository",
        url: branch.artifact.url,
      });
    }
    if (
      branch.status === "done" &&
      branch.pullRequestNumber &&
      branch.pullRequestState !== "MERGED" &&
      branch.pullRequestState !== "CLOSED"
    ) {
      buttons.push({ label: `Merge #${branch.ref}`, customId: componentId("merge", branch.ref) });
    }
    if (branch.status !== "cancelled" && branch.status !== "done") {
      buttons.push({ label: `Cancel #${branch.ref}`, customId: componentId("cancel", branch.ref), danger: true });
    }
  }
  // The interaction channel (not this card's location) is the workspace target, so attach carries
  // the task number and the click resolves the destination from where it was pressed — from a
  // plain channel, a fresh thread off this card's own message.
  buttons.push({ label: "Attach to thread", customId: componentId("attach", String(snapshot.number)) });
  return buttons;
}

function branchLine(branch: TaskCardBranchSnapshot): string {
  const parts = [`${BRANCH_STATE_ICON[branch.status]} ${BRANCH_STATE_LABEL[branch.status]}`];
  if (branch.artifact) {
    parts.push(branch.artifact.kind === "pull_request"
      ? `[PR${branch.pullRequestNumber ? ` #${branch.pullRequestNumber}` : ""}](${branch.artifact.url})`
      : `[Repository](${branch.artifact.url})`);
  }
  if (branch.preview) parts.push(`[Live preview](${branch.preview.url})`);
  return parts.join(" · ");
}

function taskStateLine(snapshot: TaskCardSnapshot): string {
  const total = snapshot.branches.length;
  const done = snapshot.branches.filter((b) => b.status === "done").length;
  const cancelled = snapshot.branches.filter((b) => b.status === "cancelled").length;
  const label = snapshot.status === "done"
    ? "Done"
    : snapshot.status === "cancelled"
      ? "Cancelled"
      : snapshot.status === "paused"
        ? "Paused"
        : "Active";
  return total > 0
    ? `**${label}** · ${done}/${total} branches done${cancelled ? ` · ${cancelled} cancelled` : ""}`
    : `**${label}**`;
}

function taskCardColor(snapshot: TaskCardSnapshot): number {
  if (snapshot.branches.some((b) => b.status === "blocked")) return RED;
  if (snapshot.status === "done") return GREEN;
  if (snapshot.status === "cancelled") return GRAY;
  if (snapshot.branches.some((b) => b.status === "review" || b.status === "approval")) return AMBER;
  if (snapshot.branches.some((b) => b.status === "running" || b.status === "designing")) return BLUE;
  return GRAY;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
