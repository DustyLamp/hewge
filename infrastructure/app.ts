import {
  App,
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ses from "aws-cdk-lib/aws-ses";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as backup from "aws-cdk-lib/aws-backup";
import * as kms from "aws-cdk-lib/aws-kms";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as smsvoice from "aws-cdk-lib/aws-smsvoice";

class HewgeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const domain = "hewge.design";
    const app = new amplify.CfnApp(this, "Hosting", {
      name: "hewge-production",
      platform: "WEB",
      customRules: [
        {
          source:
            "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|webp|avif|js|png|txt|svg|woff|woff2|ttf|map|json|xml)$)([^.]+$)/>",
          target: "/index.html",
          status: "200",
        },
      ],
    });
    const branch = new amplify.CfnBranch(this, "MainBranch", {
      appId: app.attrAppId,
      branchName: "main",
      stage: "PRODUCTION",
      enableAutoBuild: false,
      framework: "React",
    });
    const origins = [`https://${domain}`, `https://www.${domain}`];
    const table = new dynamodb.Table(this, "CommerceData", {
      tableName: "hewge-production",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });
    const auctionTable = new dynamodb.Table(this, "AuctionData", {
      tableName: "hewge-auctions",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });
    auctionTable.addGlobalSecondaryIndex({
      indexName: "directory",
      partitionKey: { name: "gpk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsk", type: dynamodb.AttributeType.STRING },
    });
    const auditTable = new dynamodb.Table(this, "AuditData", {
      tableName: "hewge-audit",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const auditBucket = new s3.Bucket(this, "AuditArchive", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(
        Duration.days(36500),
      ),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Preserve the visible audit key as well as its locked historical versions.
    auditBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [auditBucket.arnForObjects("events/*")],
        conditions: {
          Null: { "s3:if-none-match": "true" },
          Bool: { "s3:ObjectCreationOperation": "true" },
        },
      }),
    );
    auditBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
        resources: [auditBucket.arnForObjects("events/*")],
      }),
    );
    auditBucket.policy!.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const mediaBucket = new s3.Bucket(this, "MediaLibrary", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedOrigins: origins,
          allowedMethods: [s3.HttpMethods.PUT],
          allowedHeaders: ["Content-Type", "If-None-Match", "x-amz-*"],
          exposedHeaders: ["ETag"],
        },
      ],
      lifecycleRules: [
        {
          prefix: "staging/",
          expiration: Duration.days(1),
          noncurrentVersionExpiration: Duration.days(1),
        },
      ],
    });
    const nfcKey = new kms.Key(this, "TagEncryptionKey", {
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description:
        "Hewge NFC verification keys; retain for provenance continuity",
    });
    const vault = new backup.BackupVault(this, "BackupVault", {
      backupVaultName: "hewge-protected-backups",
      removalPolicy: RemovalPolicy.RETAIN,
      lockConfiguration: {
        minRetention: Duration.days(35),
        maxRetention: Duration.days(365),
        changeableFor: Duration.days(7),
      },
    });
    const plan = new backup.BackupPlan(this, "BackupPlan", {
      backupPlanName: "hewge-daily-recovery",
      backupVault: vault,
    });
    plan.addRule(
      new backup.BackupPlanRule({
        ruleName: "Daily",
        scheduleExpression: events.Schedule.cron({ minute: "0", hour: "3" }),
        deleteAfter: Duration.days(35),
        startWindow: Duration.hours(1),
        completionWindow: Duration.hours(4),
      }),
    );
    plan.addSelection("Tables", {
      resources: [
        backup.BackupResource.fromDynamoDbTable(table),
        backup.BackupResource.fromDynamoDbTable(auctionTable),
        backup.BackupResource.fromDynamoDbTable(auditTable),
      ],
    });
    const trail = new cloudtrail.Trail(this, "SecurityTrail", {
      bucket: auditBucket,
      s3KeyPrefix: "cloudtrail",
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: false,
      enableFileValidation: true,
    });
    const trailResource = trail.node.defaultChild as cloudtrail.CfnTrail;
    trailResource.eventSelectors = undefined;
    trailResource.advancedEventSelectors = [
      {
        name: "Management",
        fieldSelectors: [{ field: "eventCategory", equalTo: ["Management"] }],
      },
      {
        name: "Registry writes",
        fieldSelectors: [
          { field: "eventCategory", equalTo: ["Data"] },
          { field: "resources.type", equalTo: ["AWS::DynamoDB::Table"] },
          {
            field: "resources.ARN",
            equalTo: [auctionTable.tableArn, auditTable.tableArn],
          },
          { field: "readOnly", equalTo: ["false"] },
        ],
      },
    ];
    const users = new cognito.UserPool(this, "Collectors", {
      userPoolName: "hewge-collectors",
      selfSignUpEnabled: true,
      deletionProtection: true,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userClient = users.addClient("Web", {
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
    });
    new cognito.CfnUserPoolGroup(this, "Owners", {
      userPoolId: users.userPoolId,
      groupName: "admins",
      description: "Hewge owners — manually granted, never self assigned",
    });
    const emailIdentity = new ses.EmailIdentity(this, "BrandEmail", {
      identity: ses.Identity.publicHostedZone(
        route53.HostedZone.fromHostedZoneAttributes(this, "DnsZone", {
          hostedZoneId: "Z08500773SUN2ORMGDEA4",
          zoneName: domain,
        }),
      ),
    });
    const emailEnabled = this.node.tryGetContext("emailEnabled") === "true";
    // Swiss dynamic sender ID; no leased phone number or active SMS sending.
    // Other destinations require their own country and registration review.
    const swissSmsSender = new smsvoice.CfnSenderId(this, "SwissSmsSender", {
      senderId: "HEWGE",
      isoCountryCode: "CH",
      deletionProtectionEnabled: true,
    });
    swissSmsSender.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const emailConfig = new ses.ConfigurationSet(this, "EmailDelivery", {
      configurationSetName: "hewge-delivery",
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    emailConfig.addEventDestination("DeliveryMetrics", {
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.REJECT,
      ],
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          name: "stream",
          defaultValue: "hewge",
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
        },
      ]),
    });
    const secretArn = this.node.tryGetContext("stripeSecretArn") as
      string | undefined;
    const enabled = this.node.tryGetContext("checkoutEnabled") === "true";
    const termsUrl = this.node.tryGetContext("termsUrl") as string | undefined;
    if (
      enabled &&
      (!secretArn ||
        !termsUrl?.startsWith("https://") ||
        this.node.tryGetContext("sellerTermsApproved") !== "true" ||
        this.node.tryGetContext("provenancePrivacyApproved") !== "true" ||
        this.node.tryGetContext("auctionCardTestsApproved") !== "true")
    )
      throw Error(
        "checkoutEnabled requires stripeSecretArn, published HTTPS termsUrl, sellerTermsApproved, provenancePrivacyApproved, auctionCardTestsApproved and completed launch steps in README.",
      );
    const commerce = new NodejsFunction(this, "Commerce", {
      functionName: "hewge-commerce",
      entry: "services/platform.ts",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(25),
      logGroup: new logs.LogGroup(this, "CommerceLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        OWNER_EMAIL: "jez@hewge.design",
        AUDIT_TABLE: auditTable.tableName,
        AUDIT_BUCKET: auditBucket.bucketName,
        AUDIT_RETENTION_DAYS: "36500",
        MEDIA_BUCKET: mediaBucket.bucketName,
        NFC_KEY_ID: nfcKey.keyArn,
        NFC_ENABLED:
          this.node.tryGetContext("nfcCommissioned") === "true"
            ? "true"
            : "false",
        TRANSFER_PAYMENTS_ENABLED:
          enabled &&
          this.node.tryGetContext("transferPaymentsApproved") === "true"
            ? "true"
            : "false",
        AUCTION_TABLE: auctionTable.tableName,
        USER_POOL_ID: users.userPoolId,
        USER_POOL_CLIENT_ID: userClient.userPoolClientId,
        EMAIL_ENABLED: emailEnabled ? "true" : "false",
        EMAIL_CONFIGURATION_SET: emailConfig.configurationSetName,
        TABLE_NAME: table.tableName,
        SITE_URL: `https://${domain}`,
        ALLOWED_ORIGINS: origins.join(","),
        CHECKOUT_ENABLED: enabled ? "true" : "false",
        TERMS_URL: termsUrl || "",
        ...(secretArn ? { STRIPE_SECRET_ARN: secretArn } : {}),
      },
    });
    auditTable.grantReadWriteData(commerce);
    auditBucket.grantReadWrite(commerce);
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObjectLegalHold", "s3:PutObjectRetention"],
        resources: [auditBucket.arnForObjects("events/*")],
      }),
    );
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
        resources: [auditBucket.arnForObjects("*")],
      }),
    );
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["s3:PutObjectRetention"],
        resources: [auditBucket.arnForObjects("*")],
        conditions: {
          StringNotEquals: { "s3:object-lock-mode": "COMPLIANCE" },
        },
      }),
    );
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["s3:PutObjectLegalHold"],
        resources: [auditBucket.arnForObjects("*")],
        conditions: { StringEquals: { "s3:object-lock-legal-hold": "OFF" } },
      }),
    );
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [auditTable.tableArn],
        conditions: {
          "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["ENTITY#*"] },
        },
      }),
    );
    mediaBucket.grantReadWrite(commerce);
    nfcKey.grantDecrypt(commerce);
    table.grantReadWriteData(commerce);
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:GetAccount"],
        resources: ["*"],
      }),
    );
    auctionTable.grantReadWriteData(commerce);
    emailIdentity.grantSendEmail(commerce);
    commerce.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [
          this.formatArn({
            service: "ses",
            resource: "configuration-set",
            resourceName: emailConfig.configurationSetName,
          }),
        ],
      }),
    );
    new events.Rule(this, "AuctionClock", {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(commerce, { retryAttempts: 2 })],
    });
    if (secretArn)
      secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "StripeSecret",
        secretArn,
      ).grantRead(commerce);
    const api = new apigw.HttpApi(this, "Api", {
      apiName: "hewge-api",
      corsPreflight: {
        allowOrigins: origins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ["Content-Type", "Authorization", "X-Hewge-Studio"],
        maxAge: Duration.hours(1),
      },
    });
    commerce.addEnvironment("MEDIA_API_URL", api.apiEndpoint);
    const integration = new HttpLambdaIntegration(
      "CommerceIntegration",
      commerce,
    );
    for (const path of [
      "/catalog",
      "/content/{id}",
      "/releases",
      "/registry/{id}",
      "/me",
      "/admin",
      "/media/{id}",
    ])
      api.addRoutes({ path, methods: [apigw.HttpMethod.GET], integration });
    for (const path of [
      "/security/login",
      "/security/respond",
      "/verify/nfc",
      "/admin/tag",
      "/admin/content",
      "/admin/media/upload",
      "/admin/media/read",
      "/admin/media/complete",
      "/admin/audit",
      "/admin/campaign",
      "/admin/recovery",
      "/recovery/request",
      "/transfer/checkout",
      "/waitlist",
      "/waitlist/remove",
      "/membership/link",
      "/membership/verify",
      "/membership/session",
      "/membership/profile",
      "/checkout",
      "/stripe/webhook",
      "/me/profile",
      "/me/delete",
      "/bid",
      "/bid/receipt",
      "/withdrawal",
      "/admin/withdrawal",
      "/bid/card/setup",
      "/bid/card/status",
      "/winner/checkout",
      "/owner",
      "/transfer/request",
      "/transfer/accept",
      "/transfer/cancel",
      "/admin/transfer",
      "/admin/transfer/refund",
      "/admin/settings",
      "/admin/release",
      "/admin/next-bidder",
      "/admin/fulfillment",
      "/admin/reveal",
    ])
      api.addRoutes({ path, methods: [apigw.HttpMethod.POST], integration });
    (
      api.defaultStage!.node.defaultChild as apigw.CfnStage
    ).defaultRouteSettings = {
      throttlingRateLimit: 5,
      throttlingBurstLimit: 10,
    };
    app.customHeaders = `customHeaders:\n  - pattern: '**'\n    headers:\n      - key: X-Content-Type-Options\n        value: nosniff\n      - key: Referrer-Policy\n        value: strict-origin-when-cross-origin\n      - key: X-Frame-Options\n        value: DENY\n      - key: Strict-Transport-Security\n        value: max-age=31536000; includeSubDomains\n      - key: Permissions-Policy\n        value: camera=(), microphone=(), geolocation=()\n      - key: Content-Security-Policy\n        value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${api.apiEndpoint} https://${mediaBucket.bucketRegionalDomainName}; font-src 'self'; connect-src 'self' ${api.apiEndpoint} https://${mediaBucket.bucketRegionalDomainName} https://cognito-idp.eu-north-1.amazonaws.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"\n  - pattern: '/config.json'\n    headers:\n      - key: Cache-Control\n        value: no-store\n  - pattern: '/images/**'\n    headers:\n      - key: Cache-Control\n        value: public, max-age=86400\n  - pattern: '/assets/**'\n    headers:\n      - key: Cache-Control\n        value: public, max-age=31536000, immutable\n`;
    new CfnOutput(this, "AuditTableName", { value: auditTable.tableName });
    new CfnOutput(this, "AuditBucketName", { value: auditBucket.bucketName });
    new CfnOutput(this, "MediaBucketName", { value: mediaBucket.bucketName });
    new CfnOutput(this, "NfcKeyArn", { value: nfcKey.keyArn });
    if (this.node.tryGetContext("customDomain") === "true") {
      const hostedDomain = new amplify.CfnDomain(this, "Domain", {
        appId: app.attrAppId,
        domainName: domain,
        subDomainSettings: [
          { branchName: branch.branchName, prefix: "" },
          { branchName: branch.branchName, prefix: "www" },
        ],
        enableAutoSubDomain: false,
      });
      hostedDomain.addResourceDependency(branch);
      // Preserve the apex route explicitly: Amplify did not restore it after an earlier rollback.
      new cr.AwsCustomResource(this, "ApexAlias", {
        onCreate: {
          service: "Route53",
          action: "changeResourceRecordSets",
          parameters: {
            HostedZoneId: "Z08500773SUN2ORMGDEA4",
            ChangeBatch: {
              Changes: [
                {
                  Action: "UPSERT",
                  ResourceRecordSet: {
                    Name: domain,
                    Type: "A",
                    AliasTarget: {
                      HostedZoneId: "Z2FDTNDATAQYW2",
                      DNSName: "d2xvc6jjykye25.cloudfront.net",
                      EvaluateTargetHealth: false,
                    },
                  },
                },
              ],
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of("hewge-apex-alias"),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: ["arn:aws:route53:::hostedzone/Z08500773SUN2ORMGDEA4"],
        }),
        installLatestAwsSdk: false,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }
    new cloudwatch.Alarm(this, "CommerceErrors", {
      metric: commerce.metricErrors({ period: Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new CfnOutput(this, "UserPoolId", { value: users.userPoolId });
    new CfnOutput(this, "UserPoolClientId", {
      value: userClient.userPoolClientId,
    });
    new CfnOutput(this, "AuctionTableName", { value: auctionTable.tableName });
    new CfnOutput(this, "AmplifyAppId", { value: app.attrAppId });
    new CfnOutput(this, "DefaultUrl", {
      value: `https://main.${app.attrDefaultDomain}`,
    });
    new CfnOutput(this, "ProductionUrl", { value: `https://${domain}` });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "DataTableName", { value: table.tableName });
    new CfnOutput(this, "WebhookUrl", {
      value: `${api.apiEndpoint}/stripe/webhook`,
    });
  }
}
const app = new App();
new HewgeStack(app, "hewge-production", {
  env: { account: "082229154968", region: "eu-north-1" },
});
Tags.of(app).add("Application", "Hewge");
Tags.of(app).add("Environment", "production");
