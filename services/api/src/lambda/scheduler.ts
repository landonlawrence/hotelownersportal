import { checkMissingReports } from '../ingestion/missingReports.js';
import { dispatchNotifications } from '../notifications/dispatcher.js';

/** EventBridge Scheduler target: { task: 'missing-reports' | 'dispatch-notifications' } */
export async function handler(event: { task?: string }): Promise<unknown> {
  switch (event.task) {
    case 'missing-reports':
      return checkMissingReports();
    case 'dispatch-notifications':
      return dispatchNotifications();
    default:
      throw new Error(`Unknown scheduled task ${event.task}`);
  }
}
