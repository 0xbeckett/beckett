import { expect, test } from "bun:test";
import { ComponentRouter, componentId, decodeComponentId } from "./interactions.ts";
import type { DiscordComponentInteraction } from "../types.ts";

function interaction(customId: string, userId = "member"): DiscordComponentInteraction & { replies: string[] } {
  const replies: string[] = [];
  return {
    customId,
    userId,
    channelId: "thread-1",
    isThread: true,
    replies,
    editReply: async (content) => { replies.push(content); },
  };
}

test("component ids are versioned verb + task/branch target and reject malformed ids", () => {
  expect(componentId("merge", "12.3")).toBe("beckett:v1:merge:12.3");
  expect(decodeComponentId("beckett:v1:attach:12")).toEqual({ action: "attach", target: "12" });
  for (const id of ["merge:12", "beckett:v2:merge:12", "beckett:v1:grant:12", "beckett:v1:merge:../12"]) {
    expect(decodeComponentId(id)).toBeNull();
  }
});

test("router reclassifies clicker and refuses outsiders without running an action", async () => {
  let runs = 0;
  let classifications = 0;
  const router = new ComponentRouter((id) => {
    classifications++;
    return id === "owner" ? "owner" : "outsider";
  }).register("cancel", async () => {
    runs++;
    return "cancelled";
  });
  const click = interaction(componentId("cancel", "12.1"), "stranger");

  await router.dispatch(click);

  expect(classifications).toBe(1);
  expect(runs).toBe(0);
  expect(click.replies).toEqual(["You are not authorized to use that control."]);
});

test("router returns an unknown-custom-id refusal without dispatching", async () => {
  let runs = 0;
  const router = new ComponentRouter(() => "owner").register("attach", () => {
    runs++;
    return "attached";
  });
  const click = interaction("beckett:v1:made-up:12", "stranger");

  await router.dispatch(click);

  expect(runs).toBe(0);
  expect(click.replies).toEqual(["That control is unknown or out of date."]);
});

test("router dispatches each registered verb through the registry", async () => {
  const router = new ComponentRouter(() => "member").register("attach", (ctx) => `attached #${ctx.target}`);
  const click = interaction(componentId("attach", "44"));

  await router.dispatch(click);

  expect(click.replies).toEqual(["attached #44"]);
});

test("execute() is the shared core a reaction reuses: outsiders refused, members run the same handler", async () => {
  // A reaction (#103) has no editReply surface, so it calls execute() directly instead of dispatch.
  // Same registry, same fresh reclassification — the exact behavior a button click gets.
  const runs: string[] = [];
  const router = new ComponentRouter((id) => (id === "owner" ? "owner" : "outsider"))
    .register("merge", (ctx) => { runs.push(`merge ${ctx.target} by ${ctx.access}`); return "merged"; });

  const refused = await router.execute("merge", "12.1", interaction("", "stranger"));
  expect(refused).toEqual({ authorized: false, message: "You are not authorized to use that control." });
  expect(runs).toEqual([]); // unauthorized reaction performs NO side effect

  const ran = await router.execute("merge", "12.1", interaction("", "owner"));
  expect(ran).toEqual({ authorized: true, message: "merged" });
  expect(runs).toEqual(["merge 12.1 by owner"]);

  // An action with no registered handler is reported unauthorized (nothing ran), never thrown.
  const missing = await router.execute("cancel", "12.1", interaction("", "owner"));
  expect(missing).toEqual({ authorized: false, message: "That control is not available here." });
});
