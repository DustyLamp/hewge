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
    const users = new cognito.UserPool(this, "Collectors", {
      userPoolName: "hewge-collectors",
      selfSignUpEnabled: true,
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
    const secretArn = this.node.tryGetContext("stripeSecretArn") as
      string | undefined;
    const enabled = this.node.tryGetContext("checkoutEnabled") === "true";
    const termsUrl = this.node.tryGetContext("termsUrl") as string | undefined;
    if (
      enabled &&
      (!secretArn ||
        !termsUrl?.startsWith("https://") ||
        this.node.tryGetContext("sellerTermsApproved") !== "true")
    )
      throw Error(
        "checkoutEnabled requires stripeSecretArn, a published HTTPS termsUrl, and completed launch steps in README.",
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
        AUCTION_TABLE: auctionTable.tableName,
        USER_POOL_ID: users.userPoolId,
        USER_POOL_CLIENT_ID: userClient.userPoolClientId,
        EMAIL_ENABLED: emailEnabled ? "true" : "false",
        TABLE_NAME: table.tableName,
        SITE_URL: `https://${domain}`,
        ALLOWED_ORIGINS: origins.join(","),
        CHECKOUT_ENABLED: enabled ? "true" : "false",
        TERMS_URL: termsUrl || "",
        ...(secretArn ? { STRIPE_SECRET_ARN: secretArn } : {}),
      },
    });
    table.grantReadWriteData(commerce);
    auctionTable.grantReadWriteData(commerce);
    emailIdentity.grantSendEmail(commerce);
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
        allowHeaders: ["Content-Type", "Authorization"],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration(
      "CommerceIntegration",
      commerce,
    );
    for (const path of [
      "/catalog",
      "/releases",
      "/registry/{id}",
      "/me",
      "/admin",
    ])
      api.addRoutes({ path, methods: [apigw.HttpMethod.GET], integration });
    for (const path of [
      "/waitlist",
      "/waitlist/remove",
      "/checkout",
      "/stripe/webhook",
      "/me/profile",
      "/me/delete",
      "/bid",
      "/winner/checkout",
      "/owner",
      "/transfer/request",
      "/transfer/accept",
      "/transfer/cancel",
      "/admin/transfer",
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
    app.customHeaders = `customHeaders:\n  - pattern: '**'\n    headers:\n      - key: X-Content-Type-Options\n        value: nosniff\n      - key: Referrer-Policy\n        value: strict-origin-when-cross-origin\n      - key: X-Frame-Options\n        value: DENY\n      - key: Strict-Transport-Security\n        value: max-age=31536000; includeSubDomains\n      - key: Permissions-Policy\n        value: camera=(), microphone=(), geolocation=()\n      - key: Content-Security-Policy\n        value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${api.apiEndpoint} https://cognito-idp.eu-north-1.amazonaws.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"\n  - pattern: '/config.json'\n    headers:\n      - key: Cache-Control\n        value: no-store\n  - pattern: '/images/**'\n    headers:\n      - key: Cache-Control\n        value: public, max-age=86400\n  - pattern: '/assets/**'\n    headers:\n      - key: Cache-Control\n        value: public, max-age=31536000, immutable\n`;
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
