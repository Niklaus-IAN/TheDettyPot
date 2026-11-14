import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../lib/app-stack.js";
import { ENVIRONMENTS, REGION } from "../lib/environments.js";
import { SharedStack } from "../lib/shared-stack.js";

const env = { account: "111111111111", region: REGION };
let dev: Template;
let shared: Template;

beforeAll(() => {
  const app = new App();
  const sharedStack = new SharedStack(app, "Shared", { env });
  const devStack = new AppStack(app, "Dev", { env, settings: ENVIRONMENTS.dev!, imageTag: "abc123" });
  shared = Template.fromStack(sharedStack);
  dev = Template.fromStack(devStack);
});

type Resource = { Type: string; Properties: Record<string, any> };
const ofType = (t: Template, type: string) => Object.values(t.findResources(type)) as Resource[];
/** The logical ID of the one resource whose ID starts with `prefix`. */
const idOf = (t: Template, type: string, prefix: string) => {
  const ids = Object.keys(t.findResources(type)).filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0]!;
};

describe("network and cost", () => {
  it("has no NAT gateway and no load balancer", () => {
    dev.resourceCountIs("AWS::EC2::NatGateway", 0);
    dev.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
  });

  it("lets nothing in from the internet: the API only from API Gateway, the database only from the containers", () => {
    for (const sg of ofType(dev, "AWS::EC2::SecurityGroup")) {
      for (const rule of sg.Properties.SecurityGroupIngress ?? []) expect(rule.CidrIp ?? rule.CidrIpv6).toBeUndefined();
    }
    const rules = ofType(dev, "AWS::EC2::SecurityGroupIngress").map((r) => r.Properties);
    for (const r of rules) expect(r.CidrIp ?? r.CidrIpv6).toBeUndefined();
    const api = idOf(dev, "AWS::EC2::SecurityGroup", "ApiSg");
    const db = idOf(dev, "AWS::EC2::SecurityGroup", "DbSg");
    const link = idOf(dev, "AWS::EC2::SecurityGroup", "VpcLinkSg");
    const worker = idOf(dev, "AWS::EC2::SecurityGroup", "WorkerSg");
    const into = (sg: string) => rules.filter((r) => r.GroupId?.["Fn::GetAtt"]?.[0] === sg).map((r) => [r.SourceSecurityGroupId?.["Fn::GetAtt"]?.[0], r.FromPort]);
    expect(into(api)).toEqual([[link, 3000]]);
    expect(into(db).sort()).toEqual([[api, 5432], [worker, 5432]].sort());
  });

  it("tells the API the caller's address in a header the caller can't set", () => {
    dev.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      RequestParameters: { "overwrite:header.x-client-ip": "$context.identity.sourceIp" },
    });
  });

  it("caps traffic at the gateway", () => {
    dev.hasResourceProperties("AWS::ApiGatewayV2::Stage", { DefaultRouteSettings: { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 } });
  });

  it("lets only the website and local development call the API from a browser", () => {
    dev.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://dettypot.vercel.app", "http://localhost:5173"] }),
    });
  });
});

describe("database", () => {
  it("is private, encrypted, backed up, and on Postgres 16 like CI", () => {
    dev.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
      Engine: "postgres",
      EngineVersion: Match.stringLikeRegexp("^16"),
      DBInstanceClass: "db.t4g.micro",
    });
    const subnetGroup = ofType(dev, "AWS::RDS::DBSubnetGroup")[0]!;
    for (const s of subnetGroup.Properties.SubnetIds) expect(JSON.stringify(s)).toMatch(/dataSubnet/);
  });

  it("keeps its password in Secrets Manager, never in the template", () => {
    const dbProps = ofType(dev, "AWS::RDS::DBInstance")[0]!.Properties;
    expect(JSON.stringify(dbProps.MasterUserPassword)).toContain("secretsmanager");
  });
});

describe("containers", () => {
  const tasks = () => ofType(dev, "AWS::ECS::TaskDefinition").map((t) => t.Properties);

  it("run the commit's image on Graviton, migrating before each start", () => {
    expect(tasks()).toHaveLength(2);
    for (const t of tasks()) {
      expect(t.RuntimePlatform).toEqual({ CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" });
      const [migrate, main] = t.ContainerDefinitions;
      expect(migrate).toMatchObject({ Name: "migrate", Essential: false, Command: ["node", "dist/db/migrate.js"] });
      expect(main.DependsOn).toEqual([{ ContainerName: "migrate", Condition: "SUCCESS" }]);
      for (const c of t.ContainerDefinitions) expect(JSON.stringify(c.Image)).toContain(":abc123");
    }
  });

  it("get settings and the names of secrets, but no secret values", () => {
    for (const t of tasks()) {
      for (const c of t.ContainerDefinitions) {
        const vars = Object.fromEntries(c.Environment.map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
        expect(vars).toMatchObject({ APP_ENV: "dev", CLIENT_IP_HEADER: "x-client-ip", APP_SECRET_ID: "dettypot/dev/app", WEB_BASE_URL: "https://dettypot.vercel.app" });
        // The connection comes from API Gateway, so no forwarded address is trusted.
        expect(vars.TRUST_PROXY).toBeUndefined();
        expect(vars.TRUST_PROXY_HOPS).toBeUndefined();
        expect(vars.DATABASE_SECRET_ID).toBeDefined();
        for (const name of ["PAYSTACK_SECRET_KEY", "GOOGLE_MAPS_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL", "AUTH_DEV_JWKS_FILE"]) expect(vars[name]).toBeUndefined();
        expect(JSON.stringify(c)).not.toMatch(/sk_(test|live)_|sk-ant-|AIza/);
      }
    }
  });

  it("may read their two secrets and nothing else in Secrets Manager", () => {
    const reads = ofType(dev, "AWS::IAM::Policy")
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((s: { Action: string | string[] }) => [s.Action].flat().includes("secretsmanager:GetSecretValue"));
    const resources = new Set(reads.flatMap((s: { Resource: unknown }) => [s.Resource].flat().map((r) => JSON.stringify(r))));
    expect([...resources].some((r) => r.includes("secret:dettypot/dev/app-"))).toBe(true);
    for (const r of resources) expect(r).not.toBe('"*"');
  });

  it("check the API answers, using what the image has (no curl in it)", () => {
    const apiTask = tasks().find((t) => t.Family === "dettypot-dev-api")!;
    const main = apiTask.ContainerDefinitions[1];
    expect(main.HealthCheck.Command[0]).toBe("CMD-SHELL");
    expect(main.HealthCheck.Command[1]).toMatch(/^node -e .*127\.0\.0\.1:3000\/health/);
  });

  it("roll back a release that won't start", () => {
    dev.resourcePropertiesCountIs("AWS::ECS::Service", { DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }) }, 2);
  });
});

describe("sign-in", () => {
  it("is email and password, with the email confirmed", () => {
    dev.hasResourceProperties("AWS::Cognito::UserPool", {
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
  });

  it("sends people back only to the website or local development", () => {
    dev.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      CallbackURLs: ["https://dettypot.vercel.app/auth/callback", "http://localhost:5173/auth/callback"],
      PreventUserExistenceErrors: "ENABLED",
    });
  });
});

describe("deploying from GitHub", () => {
  it("trusts only pushes to main in this repository", () => {
    const role = ofType(shared, "AWS::IAM::Role").find((r) => r.Properties.RoleName === "dettypot-github-deploy")!;
    const condition = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
    expect(condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:Niklaus-IAN/TheDettyPot:ref:refs/heads/main",
    });
    expect(condition.StringLike).toBeUndefined();
  });

  it("keeps each image tag pointing at one build", () => {
    shared.hasResourceProperties("AWS::ECR::Repository", { RepositoryName: "dettypot-backend", ImageTagMutability: "IMMUTABLE" });
  });
});
