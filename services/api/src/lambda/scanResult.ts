import { handleGuardDutyResult, type GuardDutyScanEvent } from '../documents/scan.js';

export async function handler(event: GuardDutyScanEvent): Promise<void> {
  await handleGuardDutyResult(event);
}
