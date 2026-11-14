import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { DEPLOY_BRANCH, GITHUB_REPO, GITHUB_SUBJECT_PREFIX, IMAGE_REPOSITORY } from "./environments.js";

/**
 * What every environment shares: the backend image repository, and the role
 * GitHub Actions uses to deploy. GitHub gets short-lived credentials through
 * OpenID Connect, so no AWS keys are stored anywhere.
 */
export class SharedStack extends Stack {
  readonly repository: ecr.Repository;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "BackendImages", {
      repositoryName: IMAGE_REPOSITORY,
      imageScanOnPush: true,
      // An image tag is a commit: it never moves to point at different code.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ description: "Keep the last 30 images", maxImageCount: 30 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const github = new iam.OpenIdConnectProvider(this, "GitHub", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: "dettypot-github-deploy",
      description: `GitHub Actions deploys from ${GITHUB_REPO}@${DEPLOY_BRANCH} only`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(github.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          // Only pushes to main in this repository: not forks, other branches or pull requests.
          "token.actions.githubusercontent.com:sub": `${GITHUB_SUBJECT_PREFIX}:ref:refs/heads/${DEPLOY_BRANCH}`,
        },
      }),
    });
    this.repository.grantPullPush(this.deployRole);
    // CDK deploys through the roles `cdk bootstrap` created; this role may only step into those.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn, description: "Set as the GitHub repository variable AWS_DEPLOY_ROLE_ARN" });
    new CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
  }
}
