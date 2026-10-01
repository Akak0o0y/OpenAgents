/**
 * Composite Work Producer
 *
 * Coordinates multiple work producers (e.g. RoutineWorkProducer + BacklogWorkProducer
 * or RoutineWorkProducer + GoalDecompositionWorkProducer) under a single shared
 * concurrency ceiling.
 *
 * Evaluates child producers in priority order: scheduled routines are evaluated
 * first so time-sensitive triggers (e.g. "every day at 9 am") are never delayed
 * by background backlog cycles.
 */

import type { AgentStore } from './agent-store.js';
import type { IWorkProducer } from './work-producer.js';

export interface CompositeWorkProducerOptions {
  producers: IWorkProducer[];
  /** Maximum combined QUEUED + RUNNING task runs allowed. Defaults to 1. */
  maxQueueDepth?: number;
}

export class CompositeWorkProducer implements IWorkProducer {
  private readonly producers: IWorkProducer[];
  private readonly maxQueueDepth: number;
  private running = false;

  constructor(options: CompositeWorkProducerOptions | IWorkProducer[]) {
    if (Array.isArray(options)) {
      this.producers = [...options];
      this.maxQueueDepth = 1;
    } else {
      this.producers = [...options.producers];
      this.maxQueueDepth = options.maxQueueDepth ?? 1;
    }
  }

  async start(): Promise<void> {
    this.running = true;
    for (const p of this.producers) {
      await p.start();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const p of this.producers) {
      await p.stop();
    }
  }

  getProducers(): IWorkProducer[] {
    return [...this.producers];
  }

  async produceNextTasks(store: AgentStore): Promise<number> {
    if (!this.running) return 0;

    let totalCreated = 0;

    for (const producer of this.producers) {
      const inFlight = store.countPendingTaskRuns();

      if (inFlight >= this.maxQueueDepth) {
        break;
      }

      try {
        const created = await producer.produceNextTasks(store);
        totalCreated += created;
      } catch (err) {
        console.error(
          `[CompositeWorkProducer] Child producer ${producer.constructor.name} failed:`,
          err
        );
      }
    }

    return totalCreated;
  }
}
