import { scanDocumentVersion } from './documents/scan.js';
import { processImportRun } from './ingestion/pipeline.js';
import type { Job } from './queue/index.js';

/** Single entry point for queued jobs (SQS worker and local queue). */
export async function handleJob(job: Job): Promise<void> {
  switch (job.type) {
    case 'import.process':
      await processImportRun(job.importRunId);
      return;
    case 'document.scan':
      await scanDocumentVersion(job.versionId);
      return;
  }
}
