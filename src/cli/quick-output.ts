export function quickDetachedMessage(agent: string, runId: string, syncWaitSecs: number): string {
  return `still working (run ${runId} detached after ${syncWaitSecs}s) - the result will arrive as a quick-agent update turn; tell the person it's in progress and end this turn.`;
}
