/**
 * Beckett — frontend result screenshot (`src/preview/screenshot.ts`)
 * =======================================================================================
 * A frontend ticket used to close with nobody ever seeing the page (#75): the worker built it, the
 * ticket went green, and the browser agent and the worker never met. This wires them. When a ticket
 * finishes and its diff touched a browser-facing frontend, capture ONE screenshot of the built
 * branch and attach it to the ticket record (and, when the ticket has one, to its channel ping).
 *
 * This module owns the ORCHESTRATION only — the frontend gate, the serve→capture→attach order, and
 * the ironclad best-effort contract — with every side-effecting step injected:
 *   - {@link FrontendScreenshotDeps.changedFiles} — the built worktree's diff vs. its base.
 *   - {@link FrontendScreenshotDeps.serve} — stand the build up locally (see ./serve-build.ts).
 *   - {@link FrontendScreenshotDeps.screenshot} — a browser run against that local URL → a PNG path.
 *   - {@link FrontendScreenshotDeps.attach} — put the PNG on the ticket + channel.
 *
 * The whole thing is best-effort by construction: {@link FrontendScreenshotHook.capture} NEVER
 * throws and never leaves the local server running. A failure at any step logs and returns
 * `skipped`, so a caller can `void hook.capture(...)` without ever gating the ticket's finish.
 */

import type { Logger } from "../types.ts";
import { isFrontendChange } from "./index.ts";

/** The minimal ticket identity the capturer needs — decoupled from the tracker `Ticket` type. */
export interface ScreenshotTicketRef {
  /** Tracker ticket id — the addComment target. */
  id: string;
  /** Human identifier (e.g. `OPS-12`) — logging + captions only. */
  identifier: string;
  /** Discord channel the ticket was filed from, when any — the screenshot ping target. */
  originChannel?: string;
}

/** A locally-served build the capturer will screenshot, plus its teardown. */
export interface ServedBuild {
  url: string;
  stop: () => Promise<void>;
}

export interface FrontendScreenshotDeps {
  /** The names of files the ticket changed vs. its base, read from the BUILT worktree (not main). */
  changedFiles: (repoRoot: string, baseRef: string) => Promise<readonly string[]>;
  /** Stand the built frontend up on a local URL; null when nothing is serveable. */
  serve: (repoRoot: string) => Promise<ServedBuild | null>;
  /** Open `url` and capture ONE screenshot; the PNG path, or null on any capture failure. */
  screenshot: (url: string, ticket: ScreenshotTicketRef) => Promise<string | null>;
  /** Attach the PNG to the ticket record and (when present) its channel ping. */
  attach: (ticket: ScreenshotTicketRef, pngPath: string) => Promise<void>;
  logger: Logger;
  /**
   * Overall wall-clock backstop; the caller's worktree is held until this resolves. Keep it
   * comfortably ABOVE serve-build's internal build cap (120s) so a normal build+capture finishes
   * well within it — on the rare timeout the caller disposes the worktree, which must not land
   * mid-build. Default 180s.
   */
  timeoutMs?: number;
  /** Frontend gate override (tests); defaults to the shared {@link isFrontendChange}. */
  isFrontend?: (files: readonly string[]) => boolean;
}

export type ScreenshotOutcome =
  | { status: "attached"; pngPath: string }
  | { status: "skipped"; reason: string };

export interface FrontendScreenshotHook {
  /**
   * Capture-and-attach for a finished ticket, from its built worktree. Best-effort and terminal:
   * resolves `attached` or `skipped`, NEVER rejects. Safe to fire-and-forget.
   */
  capture(input: { ticket: ScreenshotTicketRef; workspace: string; baseRef: string }): Promise<ScreenshotOutcome>;
}

export function createFrontendScreenshotHook(deps: FrontendScreenshotDeps): FrontendScreenshotHook {
  const isFrontend = deps.isFrontend ?? isFrontendChange;
  const timeoutMs = deps.timeoutMs ?? 180_000;

  return {
    async capture({ ticket, workspace, baseRef }) {
      const skip = (reason: string): ScreenshotOutcome => {
        deps.logger.info("frontend screenshot skipped", { ticket: ticket.identifier, reason });
        return { status: "skipped", reason };
      };

      const run = async (): Promise<ScreenshotOutcome> => {
        // Non-frontend tickets are untouched — the gate runs before any serve/build side effect.
        let files: readonly string[];
        try {
          files = await deps.changedFiles(workspace, baseRef);
        } catch (err) {
          return skip(`could not read the branch diff (${(err as Error).message})`);
        }
        if (!isFrontend(files)) return skip("no frontend changes");

        const served = await deps.serve(workspace);
        if (!served) return skip("no runnable frontend build to serve");
        try {
          const pngPath = await deps.screenshot(served.url, ticket);
          if (!pngPath) return skip("browser produced no screenshot");
          await deps.attach(ticket, pngPath);
          deps.logger.info("frontend screenshot attached", { ticket: ticket.identifier });
          return { status: "attached", pngPath };
        } finally {
          await served.stop().catch((err) =>
            deps.logger.debug?.("frontend screenshot: local server teardown failed", {
              ticket: ticket.identifier,
              error: (err as Error).message,
            }),
          );
        }
      };

      try {
        return await withTimeout(timeoutMs, run());
      } catch (err) {
        // The only paths here are the timeout or an unexpected throw from an injected step. Both are
        // swallowed: a screenshot must never fail or stall the ticket it belongs to.
        deps.logger.warn("frontend screenshot: skipped after error", {
          ticket: ticket.identifier,
          error: (err as Error).message,
        });
        return { status: "skipped", reason: (err as Error).message };
      }
    },
  };
}

/** Resolve `promise`, or reject with a timeout after `ms`. */
function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
