import { App } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.js";
import { ENVIRONMENTS, REGION } from "../lib/environments.js";
import { SharedStack } from "../lib/shared-stack.js";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

new SharedStack(app, "DettyPot-shared", { env, description: "DettyPot: image repository and GitHub deploy role" });

// Environments run a specific image, so they exist only when one is named:
//   cdk deploy DettyPot-dev -c imageTag=<commit>
// Without it, a stray deploy can't roll an environment back to the wrong code.
const imageTag = app.node.tryGetContext("imageTag") as string | undefined;
if (imageTag) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(imageTag)) throw new Error(`imageTag "${imageTag}" isn't a valid image tag`);
  for (const settings of Object.values(ENVIRONMENTS)) {
    new AppStack(app, `DettyPot-${settings.name}`, { env, settings, imageTag, description: `DettyPot ${settings.name}` });
  }
}
