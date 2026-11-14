/** Where everything runs. Ireland is close to Lagos and has every service we use. */
export const REGION = "eu-west-1";

/** The GitHub repository allowed to deploy, and the only branch it may deploy from. */
export const GITHUB_REPO = "Niklaus-IAN/TheDettyPot";
export const DEPLOY_BRANCH = "main";
/**
 * How GitHub names this repository in its sign-in tokens. The repository uses
 * GitHub's immutable subjects, which carry the owner's and repository's IDs, so
 * a renamed or re-created repository with the same name can't deploy. From
 * `gh api repos/Niklaus-IAN/TheDettyPot/actions/oidc/customization/sub`.
 */
export const GITHUB_SUBJECT_PREFIX = "repo:Niklaus-IAN@105167056/TheDettyPot@1450539204";

/** The backend image, shared by every environment. */
export const IMAGE_REPOSITORY = "dettypot-backend";

export interface EnvironmentSettings {
  /** Matches the backend's APP_ENV. */
  name: "dev" | "staging" | "prod";
  /** The website: links in emails and Paystack's return address point here, and it may call the API. */
  webBaseUrl: string;
  /** Extra browser origins allowed to call the API (local development). */
  extraOrigins: string[];
  enableDocs: boolean;
  /** Real users' data: keep it when the stack is removed, and guard against deletion. */
  protectData: boolean;
}

export const ENVIRONMENTS: Record<string, EnvironmentSettings> = {
  dev: {
    name: "dev",
    webBaseUrl: "https://dettypot.vercel.app",
    extraOrigins: ["http://localhost:5173"],
    enableDocs: true,
    protectData: false,
  },
};
