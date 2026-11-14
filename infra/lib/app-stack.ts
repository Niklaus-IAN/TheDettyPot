import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import type { Construct } from "constructs";
import { IMAGE_REPOSITORY, type EnvironmentSettings } from "./environments.js";

export interface AppStackProps extends StackProps {
  settings: EnvironmentSettings;
  /** The backend image to run: the commit it was built from. */
  imageTag: string;
}

const API_PORT = 3000;
/** Set by API Gateway to the caller's address, overwriting anything the caller sent. */
const CLIENT_IP_HEADER = "x-client-ip";

/**
 * One DettyPot environment: the API and the worker on Fargate, Postgres on
 * RDS, sign-in with Cognito, and a public HTTPS address from API Gateway.
 *
 * Kept cheap on purpose: no NAT gateway (the containers sit in public subnets
 * with public addresses and accept traffic only from API Gateway) and no load
 * balancer (API Gateway reaches the API privately through a VPC link).
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { settings, imageTag } = props;
    const env = settings.name;
    const keep = settings.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ── Network ──────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const linkSg = new ec2.SecurityGroup(this, "VpcLinkSg", { vpc, description: "Entry for API Gateway", allowAllOutbound: false });
    const apiSg = new ec2.SecurityGroup(this, "ApiSg", { vpc, description: "The API containers" });
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc, description: "The worker containers" });
    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc, description: "The database", allowAllOutbound: false });
    linkSg.addEgressRule(apiSg, ec2.Port.tcp(API_PORT), "To the API");
    apiSg.addIngressRule(linkSg, ec2.Port.tcp(API_PORT), "Only from API Gateway");
    dbSg.addIngressRule(apiSg, ec2.Port.tcp(5432), "From the API");
    dbSg.addIngressRule(workerSg, ec2.Port.tcp(5432), "From the worker");

    // ── Database ─────────────────────────────────
    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      publiclyAccessible: false,
      databaseName: "dettypot",
      credentials: rds.Credentials.fromGeneratedSecret("dettypot", { secretName: `dettypot/${env}/db` }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: settings.protectData,
      backupRetention: Duration.days(7),
      deletionProtection: settings.protectData,
      removalPolicy: settings.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
    });

    /** Paystack, Google and Anthropic keys, as JSON. Created and filled by scripts/put-keys.mjs, never by CloudFormation. */
    const appKeys = secretsmanager.Secret.fromSecretNameV2(this, "AppKeys", `dettypot/${env}/app`);

    // ── Sign-in ──────────────────────────────────
    const users = new cognito.UserPool(this, "Users", {
      userPoolName: `dettypot-${env}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // A changed email only takes effect once the new address is confirmed.
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, fullname: { required: false, mutable: true } },
      passwordPolicy: { minLength: 10, requireLowercase: false, requireUppercase: false, requireDigits: false, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: settings.protectData,
      removalPolicy: keep,
    });
    const origins = [settings.webBaseUrl, ...settings.extraOrigins];
    const webClient = users.addClient("Web", {
      userPoolClientName: "web",
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: !settings.protectData },
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: origins.map((o) => `${o}/auth/callback`),
        logoutUrls: origins,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });
    const signInDomain = users.addDomain("Domain", { cognitoDomain: { domainPrefix: `dettypot-${env}` } });

    // ── Containers ───────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: `dettypot-${env}` });
    const image = ecs.ContainerImage.fromEcrRepository(ecr.Repository.fromRepositoryName(this, "Images", IMAGE_REPOSITORY), imageTag);
    const environment: Record<string, string> = {
      APP_ENV: env,
      HOST: "0.0.0.0",
      PORT: String(API_PORT),
      LOG_LEVEL: "info",
      WEB_BASE_URL: settings.webBaseUrl,
      ENABLE_DOCS: String(settings.enableDocs),
      // API Gateway's connection isn't the caller's: it puts the caller's address here (see the integration below).
      CLIENT_IP_HEADER: CLIENT_IP_HEADER,
      AUTH_ISSUER: users.userPoolProviderUrl,
      AUTH_AUDIENCE: webClient.userPoolClientId,
      APP_SECRET_ID: `dettypot/${env}/app`,
      DATABASE_SECRET_ID: db.secret!.secretArn,
    };

    const task = (name: string, command: string[], healthCheck?: ecs.HealthCheck) => {
      const def = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        family: `dettypot-${env}-${name.toLowerCase()}`,
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });
      db.secret!.grantRead(def.taskRole);
      appKeys.grantRead(def.taskRole);
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/dettypot/${env}/${name.toLowerCase()}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: keep,
      });
      // Every start applies any new migrations first (they take a lock, so starts can overlap safely).
      const migrate = def.addContainer("migrate", {
        image,
        command: ["node", "dist/db/migrate.js"],
        essential: false,
        environment,
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "migrate" }),
      });
      const main = def.addContainer(name.toLowerCase(), {
        image,
        command,
        environment,
        healthCheck,
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name.toLowerCase() }),
      });
      main.addContainerDependencies({ container: migrate, condition: ecs.ContainerDependencyCondition.SUCCESS });
      return { def, main };
    };

    // An API that starts but doesn't answer counts as failed, so the release is rolled back.
    const api = task("Api", ["node", "dist/index.js"], {
      command: ["CMD-SHELL", `node -e "fetch('http://127.0.0.1:${API_PORT}/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"`],
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      retries: 3,
      startPeriod: Duration.seconds(30),
    });
    api.main.addPortMappings({ containerPort: API_PORT });
    const worker = task("Worker", ["node", "dist/worker.js"]);

    const namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", { name: `${env}.dettypot.internal`, vpc });
    const shared = {
      cluster,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // A release that won't start is rolled back instead of taking the service down.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    };
    const apiService = new ecs.FargateService(this, "ApiService", {
      ...shared,
      serviceName: "api",
      taskDefinition: api.def,
      securityGroups: [apiSg],
      cloudMapOptions: { cloudMapNamespace: namespace, name: "api", dnsRecordType: servicediscovery.DnsRecordType.SRV, container: api.main, containerPort: API_PORT },
    });
    new ecs.FargateService(this, "WorkerService", { ...shared, serviceName: "worker", taskDefinition: worker.def, securityGroups: [workerSg] });

    // ── Public address ───────────────────────────
    const vpcLink = new apigwv2.VpcLink(this, "VpcLink", { vpc, subnets: { subnetType: ec2.SubnetType.PUBLIC }, securityGroups: [linkSg] });
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `dettypot-${env}`,
      defaultIntegration: new HttpServiceDiscoveryIntegration("Api", apiService.cloudMapService!, {
        vpcLink,
        // X-Forwarded-For and Forwarded can't be set here (API Gateway reserves them), so it passes the caller's address in its own header.
        parameterMapping: new apigwv2.ParameterMapping().overwriteHeader(CLIENT_IP_HEADER, apigwv2.MappingValue.contextVariable("identity.sourceIp")),
      }),
      corsPreflight: {
        allowOrigins: origins,
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ["authorization", "content-type", "x-request-id"],
        exposeHeaders: ["x-request-id", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining"],
        maxAge: Duration.hours(1),
      },
    });
    // A ceiling on traffic, so a flood can't run up the bill. The API has its own per-address limits below this.
    const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: users.userPoolId });
    new CfnOutput(this, "WebClientId", { value: webClient.userPoolClientId });
    new CfnOutput(this, "SignInDomain", { value: signInDomain.baseUrl() });
    new CfnOutput(this, "DatabaseSecretName", { value: `dettypot/${env}/db` });
  }
}
