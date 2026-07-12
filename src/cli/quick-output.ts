export function quickDetachedMessage(agent: string, runId: string, syncWaitSecs: number): string {
  if (agent === "computer-use") {
    return `browser run ${runId} is working independently - any blocking question will arrive with a page screenshot, and the final result will include proof when applicable. Tell the person it is in progress and end this turn.`;
  }
  return `still working (run ${runId} detached after ${syncWaitSecs}s) - the result will arrive as a quick-agent update turn; tell the person it's in progress and end this turn.`;
}
