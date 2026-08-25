/**
 * StepEventBus buffers per-step lifecycle events so a caller can observe,
 * without dialogs, exactly what the editor did and in what order.
 *
 * Every committed mutation is a distinct undo unit and produces a
 * "committed" event carrying the before/after project revision. A reverted
 * step produces a "reverted" event so the observer can see the editor roll
 * back.
 */

export type FlowStepPhase = "queued" | "executing" | "committed" | "reverted" | "skipped" | "failed";

export interface FlowStepEvent {
  eventId: string;
  flowId: string;
  stepId: string;
  actionId: string;
  phase: FlowStepPhase;
  message: string;
  target?: string;
  beforeRevision: string | null;
  afterRevision: string | null;
  timestamp: string;
}

const MAX_EVENTS = 1_024;

export class StepEventBus {
  readonly #events: FlowStepEvent[] = [];
  #counter = 0;

  emit(event: Omit<FlowStepEvent, "eventId" | "timestamp">): FlowStepEvent {
    const record: FlowStepEvent = {
      ...event,
      eventId: `ev-${(++this.#counter).toString(36)}`,
      timestamp: new Date().toISOString(),
    };
    this.#events.push(record);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    return record;
  }

  /** Drain all buffered events, optionally limited to one flow, since the given cursor. */
  drain(options: { afterEventId?: string; flowId?: string } = {}): FlowStepEvent[] {
    let start = 0;
    if (options.afterEventId) {
      const idx = this.#events.findIndex((event) => event.eventId === options.afterEventId);
      if (idx >= 0) start = idx + 1;
    }
    const sliced = options.afterEventId ? this.#events.slice(start) : this.#events;
    return options.flowId ? sliced.filter((event) => event.flowId === options.flowId) : sliced;
  }

  history(): readonly FlowStepEvent[] {
    return [...this.#events];
  }
}
