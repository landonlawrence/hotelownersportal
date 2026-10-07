import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SESEvent } from 'aws-lambda';
import { handleInboundEmail } from '../ingestion/email.js';

const s3 = new S3Client({});

/**
 * Invoked by the SES receipt rule after the raw message is written to the
 * private inbound bucket (S3 action precedes the Lambda action).
 */
export async function handler(event: SESEvent): Promise<void> {
  const bucket = process.env.INBOUND_EMAIL_BUCKET!;
  const prefix = process.env.INBOUND_EMAIL_PREFIX ?? 'inbound/';
  for (const record of event.Records) {
    const mail = record.ses.mail;
    const receipt = record.ses.receipt;
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${mail.messageId}` }));
    const raw = await obj.Body!.transformToByteArray();
    const outcome = await handleInboundEmail(raw, {
      recipients: receipt.recipients,
      spfVerdict: receipt.spfVerdict?.status,
      dkimVerdict: receipt.dkimVerdict?.status,
      messageId: mail.messageId,
    });
    console.info(JSON.stringify({ level: 'info', event: 'inbound_email', messageId: mail.messageId, accepted: outcome.accepted, reason: outcome.reason, runs: outcome.runs.length }));
  }
}
