# Cost Drivers

No paid resources have been created. Estimates are directional for a pilot (≈5 companies, 50 hotels, 300 users, daily emails per hotel) and must be validated with the AWS/Supabase pricing calculators for the chosen region.

| Service | Driver | Pilot expectation |
|---|---|---|
| Supabase | Plan tier (Pro per project; staging + production = 2 projects), compute add-on size, PITR add-on, database size, egress | Largest fixed cost. PITR recommended for production. |
| AWS Lambda | Invocations × duration × memory (API 1 GB, worker 1.5 GB) | Low (free tier often covers pilot volume). |
| API Gateway (HTTP) | Requests | Low. |
| S3 | GB-month stored (documents, source files, versions), requests | Low → grows with document volume; 7-year noncurrent retention in production. |
| KMS | $/key/month + requests (bucket keys enabled to reduce requests) | Low. |
| SQS | Requests | Negligible. |
| CloudFront | Data transfer, requests | Low. |
| SES | Inbound emails received, outbound emails sent | Low. |
| GuardDuty Malware Protection for S3 | GB scanned + objects evaluated | Optional (`enableMalwareScanning`); scales with upload volume. When off, uploads require manual release. |
| CloudWatch | Log ingestion/storage (1-year retention in prod), alarms, X-Ray traces | Low–moderate; reduce retention or sampling if needed. |
| Secrets Manager | Per secret/month | Negligible. |
| WAF (not provisioned) | Web ACL + rules + requests | Recommended for production; adds a fixed monthly cost. |

Deliberately avoided: VPC/NAT gateways, RDS, always-on containers, OpenSearch — none are required because Supabase hosts the database and all compute is serverless.
