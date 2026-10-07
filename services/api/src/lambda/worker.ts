import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { handleJob } from '../jobs.js';
import type { Job } from '../queue/index.js';

/**
 * SQS consumer with partial batch failures: failed messages return to the queue
 * and move to the DLQ after maxReceiveCount (configured in infra).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await handleJob(JSON.parse(record.body) as Job);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', messageId: record.messageId, error: (e as Error).message }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
