import { App, Stack, Duration, RemovalPolicy, CfnOutput, Tags, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

class HewgeStack extends Stack {
 constructor(scope:Construct,id:string,props:StackProps) {
  super(scope,id,props);
  const domain='hewge.design';
  const app=new amplify.CfnApp(this,'Hosting',{name:'hewge-production',platform:'WEB',customRules:[{source:'</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|webp|avif|js|png|txt|svg|woff|woff2|ttf|map|json|xml)$)([^.]+$)/>',target:'/index.html',status:'200'}]});
  const branch=new amplify.CfnBranch(this,'MainBranch',{appId:app.attrAppId,branchName:'main',stage:'PRODUCTION',enableAutoBuild:false,framework:'React'});
  const origins=[`https://${domain}`,`https://www.${domain}`];
  const table=new dynamodb.Table(this,'CommerceData',{tableName:'hewge-production',partitionKey:{name:'pk',type:dynamodb.AttributeType.STRING},billingMode:dynamodb.BillingMode.PAY_PER_REQUEST,timeToLiveAttribute:'expiresAt',encryption:dynamodb.TableEncryption.AWS_MANAGED,removalPolicy:RemovalPolicy.RETAIN,deletionProtection:true});
  const secretArn=this.node.tryGetContext('stripeSecretArn') as string|undefined;
  const enabled=this.node.tryGetContext('checkoutEnabled')==='true';
  const termsUrl=this.node.tryGetContext('termsUrl') as string|undefined;
  if(enabled&&(!secretArn||!termsUrl?.startsWith('https://')))throw Error('checkoutEnabled requires stripeSecretArn, a published HTTPS termsUrl, and completed launch steps in README.');
  const commerce=new NodejsFunction(this,'Commerce',{functionName:'hewge-commerce',entry:'services/commerce.ts',runtime:lambda.Runtime.NODEJS_22_X,architecture:lambda.Architecture.ARM_64,memorySize:256,timeout:Duration.seconds(25),logGroup:new logs.LogGroup(this,'CommerceLogs',{retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.DESTROY}),bundling:{minify:true,sourceMap:false,externalModules:[]},environment:{TABLE_NAME:table.tableName,SITE_URL:`https://${domain}`,ALLOWED_ORIGINS:origins.join(','),CHECKOUT_ENABLED:enabled?'true':'false',TERMS_URL:termsUrl||'',...(secretArn?{STRIPE_SECRET_ARN:secretArn}:{})}});
  table.grantReadWriteData(commerce);
  if(secretArn)secretsmanager.Secret.fromSecretCompleteArn(this,'StripeSecret',secretArn).grantRead(commerce);
  const api=new apigw.HttpApi(this,'Api',{apiName:'hewge-api',corsPreflight:{allowOrigins:origins,allowMethods:[apigw.CorsHttpMethod.GET,apigw.CorsHttpMethod.POST],allowHeaders:['Content-Type'],maxAge:Duration.hours(1)}});
  const integration=new HttpLambdaIntegration('CommerceIntegration',commerce);
  api.addRoutes({path:'/catalog',methods:[apigw.HttpMethod.GET],integration});
  for(const path of ['/waitlist','/waitlist/remove','/checkout','/stripe/webhook'])api.addRoutes({path,methods:[apigw.HttpMethod.POST],integration});
  (api.defaultStage!.node.defaultChild as apigw.CfnStage).defaultRouteSettings={throttlingRateLimit:5,throttlingBurstLimit:10};
  app.customHeaders=`customHeaders:\n  - pattern: '**'\n    headers:\n      - key: X-Content-Type-Options\n        value: nosniff\n      - key: Referrer-Policy\n        value: strict-origin-when-cross-origin\n      - key: X-Frame-Options\n        value: DENY\n      - key: Strict-Transport-Security\n        value: max-age=31536000; includeSubDomains\n      - key: Permissions-Policy\n        value: camera=(), microphone=(), geolocation=()\n      - key: Content-Security-Policy\n        value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${api.apiEndpoint}; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"\n  - pattern: '/config.json'\n    headers:\n      - key: Cache-Control\n        value: no-store\n  - pattern: '/images/**'\n    headers:\n      - key: Cache-Control\n        value: public, max-age=86400\n  - pattern: '/assets/**'\n    headers:\n      - key: Cache-Control\n        value: public, max-age=31536000, immutable\n`;
  if(this.node.tryGetContext('customDomain')==='true'){
   const hostedDomain=new amplify.CfnDomain(this,'Domain',{appId:app.attrAppId,domainName:domain,subDomainSettings:[{branchName:branch.branchName,prefix:''},{branchName:branch.branchName,prefix:'www'}],enableAutoSubDomain:false});hostedDomain.addResourceDependency(branch);
   // Amplify manages certificate validation and routing records in this account's Route 53 zone.
  }
  new cloudwatch.Alarm(this,'CommerceErrors',{metric:commerce.metricErrors({period:Duration.minutes(5)}),threshold:3,evaluationPeriods:1,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
  new CfnOutput(this,'AmplifyAppId',{value:app.attrAppId});new CfnOutput(this,'DefaultUrl',{value:`https://main.${app.attrDefaultDomain}`});new CfnOutput(this,'ProductionUrl',{value:`https://${domain}`});new CfnOutput(this,'ApiUrl',{value:api.apiEndpoint});new CfnOutput(this,'DataTableName',{value:table.tableName});new CfnOutput(this,'WebhookUrl',{value:`${api.apiEndpoint}/stripe/webhook`});
 }
}
const app=new App();new HewgeStack(app,'hewge-production',{env:{account:'082229154968',region:'eu-north-1'}});Tags.of(app).add('Application','Hewge');Tags.of(app).add('Environment','production');
