import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as integrations,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_events as events,
  aws_events_targets as targets,
  aws_guardduty as guardduty,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventSources,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  aws_ses_actions as sesActions,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface PortalStackProps extends StackProps {
  /** 'staging' | 'production' — separate stacks, accounts recommended. */
  envName: 'staging' | 'production';
  /** Supabase project for THIS environment (never share staging and production). */
  supabaseUrl: string;
  /** Publishable/anon key (safe for browsers). */
  supabaseAnonKey: string;
  /** Allowed browser origins (static patterns). Verified tenant domains are allowed dynamically. */
  allowedOrigins: string[];
  /** Optional custom domains for the SPA (must be covered by certificateArn, in us-east-1). */
  appDomainNames?: string[];
  certificateArn?: string;
  /** Domain whose MX points at SES inbound (e.g. inbound.portal.example). Omit to skip email ingestion. */
  inboundEmailDomain?: string;
  /** Verified SES identity for outbound notification email. Omit to keep notifications in-app only. */
  notificationFromAddress?: string;
  /** GuardDuty Malware Protection for S3 (paid per GB scanned). When false, uploads require manual release. */
  enableMalwareScanning: boolean;
  /** Email for operational alarms. */
  alarmEmail?: string;
  /** Directory containing built Lambda bundles (services/api/dist/lambda). */
  lambdaAssetDir: string;
}

export class PortalStack extends Stack {
  constructor(scope: Construct, id: string, props: PortalStackProps) {
    super(scope, id, props);
    const prod = props.envName === 'production';
    const retain = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ---------------------------------------------------------------- keys & secrets
    const key = new kms.Key(this, 'DataKey', {
      alias: `alias/hop-${props.envName}-data`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'Encrypts documents, source files, inbound email and queues',
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Encrypt', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    // The value is set out of band (see docs/DEPLOYMENT.md); it is never in source control or the browser.
    const serviceRoleSecret = new secretsmanager.Secret(this, 'SupabaseServiceRoleKey', {
      secretName: `hop/${props.envName}/supabase-service-role-key`,
      description: `Supabase service-role key for the ${props.envName} project (server-side only)`,
      encryptionKey: key,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------- storage
    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
      removalPolicy: retain,
      autoDeleteObjects: !prod,
    });

    const privateBucket = (id: string, extra: Partial<s3.BucketProps> = {}) =>
      new s3.Bucket(this, id, {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        bucketKeyEnabled: true,
        enforceSSL: true,
        versioned: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        serverAccessLogsBucket: accessLogs,
        serverAccessLogsPrefix: `${id}/`,
        removalPolicy: retain,
        autoDeleteObjects: !prod,
        ...extra,
      });

    const documentsBucket = privateBucket('Documents', {
      lifecycleRules: [
        // Unscanned/rejected uploads never linger.
        { id: 'quarantine-expiry', prefix: 'quarantine/', expiration: Duration.days(30) },
        { id: 'noncurrent', noncurrentVersionExpiration: Duration.days(prod ? 2555 : 30) },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: props.allowedOrigins,
          allowedHeaders: ['*'],
          maxAge: 600,
        },
      ],
    });
    const sourceFilesBucket = privateBucket('SourceFiles', {
      lifecycleRules: [{ id: 'archive', transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(180) }] }],
    });
    const inboundEmailBucket = privateBucket('InboundEmail', {
      versioned: false,
      lifecycleRules: [{ id: 'expire-raw-mail', expiration: Duration.days(prod ? 400 : 30) }],
    });
    inboundEmailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [inboundEmailBucket.arnForObjects('inbound/*')],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    // ---------------------------------------------------------------- queues
    const dlq = new sqs.Queue(this, 'ImportDlq', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const workerTimeout = Duration.minutes(5);
    const importQueue = new sqs.Queue(this, 'ImportQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      enforceSSL: true,
    });

    // ---------------------------------------------------------------- lambdas
    const commonEnv: Record<string, string> = {
      APP_ENV: props.envName,
      SUPABASE_URL: props.supabaseUrl,
      SUPABASE_ANON_KEY: props.supabaseAnonKey,
      SUPABASE_SERVICE_ROLE_SECRET_ARN: serviceRoleSecret.secretArn,
      STORAGE_DRIVER: 's3',
      QUEUE_DRIVER: 'sqs',
      IMPORT_QUEUE_URL: importQueue.queueUrl,
      DOCUMENTS_BUCKET: documentsBucket.bucketName,
      SOURCE_FILES_BUCKET: sourceFilesBucket.bucketName,
      SCAN_MODE: props.enableMalwareScanning ? 'guardduty' : 'none',
      EMAIL_DRIVER: props.notificationFromAddress ? 'ses' : 'log',
      EMAIL_FROM_ADDRESS: props.notificationFromAddress ?? 'no-reply@invalid.example',
      INBOUND_EMAIL_DOMAIN: props.inboundEmailDomain ?? 'disabled.invalid',
      ALLOWED_ORIGINS: props.allowedOrigins.join(','),
      PUBLIC_APP_URL: props.appDomainNames?.[0] ? `https://${props.appDomainNames[0]}` : 'https://invalid.example',
      NODE_OPTIONS: '--enable-source-maps',
    };

    const fn = (name: string, opts: Partial<lambda.FunctionProps> = {}) => {
      const dir = join(props.lambdaAssetDir, name);
      if (!existsSync(join(dir, 'index.mjs'))) {
        throw new Error(`Lambda bundle missing: ${dir}/index.mjs — run "npm run build -w services/api" first`);
      }
      const f = new lambda.Function(this, `${name[0]!.toUpperCase()}${name.slice(1)}Fn`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(dir),
        memorySize: 512,
        timeout: Duration.seconds(30),
        environment: commonEnv,
        tracing: lambda.Tracing.ACTIVE,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: prod ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
          removalPolicy: retain,
        }),
        ...opts,
      });
      serviceRoleSecret.grantRead(f);
      return f;
    };

    const apiFn = fn('api', { memorySize: 1024, timeout: Duration.seconds(29) });
    documentsBucket.grantReadWrite(apiFn); // presign PUT/GET, verify, release (move)
    documentsBucket.grantDelete(apiFn);
    sourceFilesBucket.grantPut(apiFn); // manual import intake
    importQueue.grantSendMessages(apiFn);

    const workerFn = fn('worker', { timeout: workerTimeout, memorySize: 1536, reservedConcurrentExecutions: prod ? 10 : 2 });
    sourceFilesBucket.grantRead(workerFn);
    documentsBucket.grantReadWrite(workerFn);
    documentsBucket.grantDelete(workerFn);
    workerFn.addEventSource(new eventSources.SqsEventSource(importQueue, { batchSize: 5, reportBatchItemFailures: true }));

    const schedulerFn = fn('scheduler', { timeout: Duration.minutes(5) });
    if (props.notificationFromAddress) {
      schedulerFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'], conditions: { StringEquals: { 'ses:FromAddress': props.notificationFromAddress } } }));
    }
    const schedulerRole = new iam.Role(this, 'SchedulerRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    schedulerFn.grantInvoke(schedulerRole);
    new scheduler.CfnSchedule(this, 'MissingReportsSchedule', {
      scheduleExpression: 'rate(1 hour)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: schedulerFn.functionArn, roleArn: schedulerRole.roleArn, input: JSON.stringify({ task: 'missing-reports' }) },
    });
    new scheduler.CfnSchedule(this, 'NotificationDispatchSchedule', {
      scheduleExpression: 'rate(5 minutes)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: schedulerFn.functionArn, roleArn: schedulerRole.roleArn, input: JSON.stringify({ task: 'dispatch-notifications' }) },
    });

    // ---------------------------------------------------------------- HTTP API
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `hop-${props.envName}`,
      description: 'Owner portal API (documents, imports, exports, invitations)',
      defaultIntegration: new integrations.HttpLambdaIntegration('ApiIntegration', apiFn),
      createDefaultStage: false,
    });
    const apiLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention: logs.RetentionDays.ONE_YEAR, removalPolicy: retain });
    new apigw.CfnStage(this, 'ApiStage', {
      apiId: httpApi.apiId,
      stageName: '$default',
      autoDeploy: true,
      defaultRouteSettings: { throttlingBurstLimit: 200, throttlingRateLimit: 100 },
      accessLogSettings: {
        destinationArn: apiLogs.logGroupArn,
        format: JSON.stringify({ requestId: '$context.requestId', ip: '$context.identity.sourceIp', method: '$context.httpMethod', path: '$context.path', status: '$context.status', latency: '$context.responseLatency' }),
      },
    });

    // ---------------------------------------------------------------- inbound email
    if (props.inboundEmailDomain) {
      const emailFn = fn('emailReceiver', { timeout: Duration.minutes(2), environment: { ...commonEnv, INBOUND_EMAIL_BUCKET: inboundEmailBucket.bucketName, INBOUND_EMAIL_PREFIX: 'inbound/' } });
      inboundEmailBucket.grantRead(emailFn);
      sourceFilesBucket.grantPut(emailFn);
      importQueue.grantSendMessages(emailFn);
      // NOTE: only one receipt rule set can be active per account/region; activate it explicitly (docs/DEPLOYMENT.md).
      const ruleSet = new ses.ReceiptRuleSet(this, 'InboundRules', { receiptRuleSetName: `hop-${props.envName}-inbound` });
      ruleSet.addRule('ScheduledReports', {
        recipients: [props.inboundEmailDomain],
        scanEnabled: true,
        tlsPolicy: ses.TlsPolicy.REQUIRE,
        actions: [
          new sesActions.S3({ bucket: inboundEmailBucket, objectKeyPrefix: 'inbound/', kmsKey: key }),
          new sesActions.Lambda({ function: emailFn, invocationType: sesActions.LambdaInvocationType.EVENT }),
        ],
      });
    }

    // ---------------------------------------------------------------- malware scanning
    if (props.enableMalwareScanning) {
      const scanFn = fn('scanResult', { timeout: Duration.minutes(2) });
      documentsBucket.grantReadWrite(scanFn);
      documentsBucket.grantDelete(scanFn);
      const gdRole = new iam.Role(this, 'MalwareProtectionRole', { assumedBy: new iam.ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com') });
      documentsBucket.grantRead(gdRole);
      gdRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObjectTagging', 's3:GetObjectTagging', 's3:GetObjectVersionTagging', 's3:PutObjectVersionTagging', 's3:PutBucketNotification', 's3:GetBucketNotification', 's3:GetBucketLocation', 's3:ListBucket'], resources: [documentsBucket.bucketArn, documentsBucket.arnForObjects('*')] }));
      gdRole.addToPolicy(new iam.PolicyStatement({ actions: ['events:PutRule', 'events:DeleteRule', 'events:PutTargets', 'events:RemoveTargets', 'events:DescribeRule'], resources: [`arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`] }));
      key.grantDecrypt(gdRole);
      new guardduty.CfnMalwareProtectionPlan(this, 'DocumentsMalwareProtection', {
        role: gdRole.roleArn,
        protectedResource: { s3Bucket: { bucketName: documentsBucket.bucketName, objectPrefixes: ['quarantine/'] } },
        actions: { tagging: { status: 'ENABLED' } },
      });
      new events.Rule(this, 'MalwareScanResults', {
        eventPattern: { source: ['aws.guardduty'], detailType: ['GuardDuty Malware Protection Object Scan Result'], detail: { s3ObjectDetails: { bucketName: [documentsBucket.bucketName] } } },
        targets: [new targets.LambdaFunction(scanFn, { retryAttempts: 4 })],
      });
    }

    // ---------------------------------------------------------------- web hosting
    const webBucket = new s3.Bucket(this, 'WebApp', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: retain,
      autoDeleteObjects: !prod,
    });
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            `connect-src 'self' ${props.supabaseUrl} ${httpApi.apiEndpoint} https://*.amazonaws.com`,
            "img-src 'self' data: https:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(730), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
      ],
      domainNames: props.appDomainNames,
      certificate: props.certificateArn ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn) : undefined,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket: accessLogs,
      logFilePrefix: 'cloudfront/',
    });

    // ---------------------------------------------------------------- alarms
    const topic = new sns.Topic(this, 'Alarms', { masterKey: key });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string) =>
      new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      }).addAlarmAction(new cwActions.SnsAction(topic));
    alarm('DlqNotEmpty', dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }), 1, 'Import jobs failed 5 times and reached the DLQ');
    alarm('ApiErrors', apiFn.metricErrors({ period: Duration.minutes(5) }), 5, 'API Lambda errors');
    alarm('Api5xx', new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: '5xx', dimensionsMap: { ApiId: httpApi.apiId }, period: Duration.minutes(5), statistic: 'Sum' }), 10, 'API 5xx responses');
    alarm('WorkerErrors', workerFn.metricErrors({ period: Duration.minutes(15) }), 3, 'Import worker errors');
    alarm('SchedulerErrors', schedulerFn.metricErrors({ period: Duration.hours(1) }), 2, 'Scheduled job errors');
    alarm('QueueAge', importQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5) }), 900, 'Imports waiting > 15 minutes');

    // ---------------------------------------------------------------- outputs
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'ServiceRoleSecretArn', { value: serviceRoleSecret.secretArn });
    new CfnOutput(this, 'ImportDlqUrl', { value: dlq.queueUrl });
  }
}
