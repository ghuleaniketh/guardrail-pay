import type { DemoEvent, DemoRun } from './types.js';

export interface DemoEventStore {
  append(event: DemoEvent): void;
  saveRun(run: DemoRun): void;
  getRun(runId: string): DemoRun | undefined;
  listRuns(): readonly DemoRun[];
  list(input: { runId: string; after?: string }): readonly DemoEvent[];
  clear(): void;
}

export function createInMemoryDemoEventStore(): DemoEventStore {
  const eventsByRunId = new Map<string, DemoEvent[]>();
  const runs = new Map<string, DemoRun>();
  return {
    append(event) {
      const runEvents = eventsByRunId.get(event.runId) ?? [];
      runEvents.push(event);
      eventsByRunId.set(event.runId, runEvents);
    },
    saveRun(run) {
      runs.set(run.runId, run);
    },
    getRun(runId) {
      return runs.get(runId);
    },
    listRuns() {
      return [...runs.values()];
    },
    list({ runId, after }) {
      return (eventsByRunId.get(runId) ?? []).filter((event) => after === undefined || event.timestamp > after);
    },
    clear() {
      eventsByRunId.clear();
      runs.clear();
    },
  };
}
