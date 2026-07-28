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
