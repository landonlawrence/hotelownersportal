import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../config.js';

export type Job = { type: 'import.process'; importRunId: string } | { type: 'document.scan'; versionId: string };

export interface JobQueue {
  send(job: Job): Promise<void>;
}

export type JobHandler = (job: Job) => Promise<void>;

/** Durable queue in AWS: SQS with a dead-letter queue (configured in infra). */
export class SqsQueue implements JobQueue {
  constructor(
    private readonly queueUrl: string,
    private readonly sqs = new SQSClient({}),
  ) {}
  async send(job: Job): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }));
  }
}

/**
 * In-process queue for local development and tests. Same contract as SQS:
 * at-least-once delivery, retries with backoff, and a dead-letter list after
 * maxAttempts. Handlers must be idempotent.
 */
export class LocalQueue implements JobQueue {
  readonly deadLetters: Array<{ job: Job; error: string }> = [];
  private pending = new Set<Promise<void>>();
  private handler: JobHandler | undefined;

  constructor(
    private readonly maxAttempts = 5,
    private readonly baseDelayMs = 50,
  ) {}

  setHandler(h: JobHandler): void {
    this.handler = h;
  }

  async send(job: Job): Promise<void> {
    const p = this.run(job, 1).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async run(job: Job, attempt: number): Promise<void> {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 0 : this.baseDelayMs * 2 ** (attempt - 2)));
    if (!this.handler) throw new Error('LocalQueue has no handler');
    try {
      await this.handler(job);
    } catch (e) {
      if (attempt >= this.maxAttempts) {
        this.deadLetters.push({ job, error: (e as Error).message });
        console.error(`[queue] job moved to dead-letter list after ${attempt} attempts`, job, e);
        return;
      }
      return this.run(job, attempt + 1);
    }
  }

  /** Wait until all queued work (including retries) has finished. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

let instance: JobQueue | undefined;

export function queue(): JobQueue {
  if (instance) return instance;
  const cfg = config();
  if (cfg.QUEUE_DRIVER === 'sqs') {
    if (!cfg.IMPORT_QUEUE_URL) throw new Error('IMPORT_QUEUE_URL is required for SQS');
    instance = new SqsQueue(cfg.IMPORT_QUEUE_URL);
  } else {
    instance = new LocalQueue();
  }
  return instance;
}

export function setQueue(q: JobQueue): void {
  instance = q;
}
