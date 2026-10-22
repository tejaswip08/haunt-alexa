import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

try {
  process.loadEnvFile(path.join(ROOT_DIR, ".env"));
} catch {
  // No .env file: rely on the real environment.
}

type Backend = "bedrock" | "mock";

function backend(value: string | undefined, fallback: Backend): Backend {
  if (value === undefined || value === "") return fallback;
  if (value === "bedrock" || value === "mock") return value;
  throw new Error(`Expected "bedrock" or "mock", got "${value}"`);
}

const storyBackend = backend(process.env.HAUNT_PROVIDER, "bedrock");

/** HAUNT_AUTH=mock: offline sign-in for local testing (see mock-auth.ts). Refused in production. */
const authMock = process.env.HAUNT_AUTH === "mock";
if (authMock && process.env.NODE_ENV === "production") {
  throw new Error("HAUNT_AUTH=mock is for local development only. Configure a Cognito user pool for production.");
}

/**
 * Production must never fall back silently: no local file store (container disks are wiped),
 * and no scripted mock stand-ins for the AI or speech services. Returns the problems found.
 */
/** A DynamoDB address on this machine (DynamoDB Local), never a real AWS endpoint. */
/**
 * Credentials for the DynamoDB clients. DynamoDB Local accepts any values but keeps each set of tables under the key that
 * made them, so local development always uses one fixed key. Only when the endpoint is local: a real AWS endpoint gets the
 * standard chain. Bedrock is not affected and keeps using the AWS profile or role.
 */
export function dynamoCredentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
  return isLocalEndpoint(process.env.AWS_ENDPOINT_URL_DYNAMODB) ? { accessKeyId: "local", secretAccessKey: "local" } : undefined;
}

export function isLocalEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Outside production (NODE_ENV is anything but "production"), the server still refuses the setups that could reach live
 * data or accept mock sign-in by accident. So a missing NODE_ENV can never turn these on.
 */
export function localSafetyProblems(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV === "production") return [];
  const problems: string[] = [];
  if (env.HAUNT_STORE === "dynamodb" && !isLocalEndpoint(env.AWS_ENDPOINT_URL_DYNAMODB)) {
    problems.push(
      'HAUNT_STORE="dynamodb" outside production needs AWS_ENDPOINT_URL_DYNAMODB set to a local address. Set NODE_ENV=production for the live service.',
    );
  }
  if (env.HAUNT_AUTH === "mock" && env.NODE_ENV !== "development") {
    problems.push('HAUNT_AUTH="mock" needs NODE_ENV=development.');
  }
  return problems;
}

export function productionProblems(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (env.HAUNT_STORE !== "dynamodb") {
    problems.push(`HAUNT_STORE must be "dynamodb" in production (got ${env.HAUNT_STORE ? `"${env.HAUNT_STORE}"` : "unset"}).`);
  }
  if (env.HAUNT_PROVIDER === "mock") problems.push('HAUNT_PROVIDER="mock" is for local development only.');
  if (env.HAUNT_AGENT === "mock") problems.push('HAUNT_AGENT="mock" is for local development only.');
  if (env.HAUNT_STT === "mock") problems.push('HAUNT_STT="mock" is for local development only.');
  // The intended providers must be named explicitly, so a missing setting can't quietly fall back to something else.
  if (env.HAUNT_PROVIDER !== "bedrock") problems.push('HAUNT_PROVIDER must be "bedrock" in production.');
  if (env.HAUNT_AGENT !== "bedrock") problems.push('HAUNT_AGENT must be "bedrock" in production.');
  if (env.HAUNT_TTS !== "polly") problems.push('HAUNT_TTS must be "polly" in production (browser narration is for local testing).');
  // Sign-in is required: without the user pool and app client, every listener would silently be a guest.
  if (!env.HAUNT_COGNITO_USER_POOL_ID) problems.push("HAUNT_COGNITO_USER_POOL_ID must be set in production.");
  if (!env.HAUNT_COGNITO_CLIENT_ID) problems.push("HAUNT_COGNITO_CLIENT_ID must be set in production.");
  // Converse is the planned API: the Anthropic-compatible path has a refusal fallback that retries on Opus.
  if (env.HAUNT_BEDROCK_API !== "converse") problems.push('HAUNT_BEDROCK_API must be "converse" in production.');
  // The public address is set after the service exists (deploy/DEPLOY.md). Until then, only bootstrap mode may start,
  // and it serves nothing but the health probes. It never substitutes the request's Host header.
  const hasPublicUrl = /^https:\/\/[^\s/]+/.test(env.HAUNT_PUBLIC_URL ?? "");
  if (env.HAUNT_BOOTSTRAP !== undefined && env.HAUNT_BOOTSTRAP !== "1") problems.push('HAUNT_BOOTSTRAP must be "1" or unset.');
  if (env.HAUNT_BOOTSTRAP === "1" && hasPublicUrl) problems.push("Remove HAUNT_BOOTSTRAP once HAUNT_PUBLIC_URL is set.");
  if (env.HAUNT_BOOTSTRAP !== "1" && !hasPublicUrl) problems.push("HAUNT_PUBLIC_URL must be the public https address in production.");
  for (const name of ["HAUNT_DAILY_TTS_REQUESTS", "HAUNT_DAILY_AGENT_REQUESTS", "HAUNT_DAILY_USER_TTS_REQUESTS", "HAUNT_DAILY_USER_AGENT_REQUESTS"]) {
    const value = env[name];
    if (value !== undefined && !/^[1-9]\d{0,6}$/.test(value)) problems.push(`${name} must be a whole number of requests per day.`);
  }
  return problems;
}

const productionErrors = productionProblems(process.env);
if (productionErrors.length) {
  throw new Error(`Refusing to start in production:\n- ${productionErrors.join("\n- ")}`);
}
const localErrors = localSafetyProblems(process.env);
if (localErrors.length) {
  throw new Error(`Refusing to start:\n- ${localErrors.join("\n- ")}`);
}

/** Days to keep stories after their last turn. "0" keeps them forever; anything unreadable falls back to 30. */
export function ttlDays(value: string | undefined, fallback = 30): number {
  if (value === undefined || value.trim() === "") return fallback;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    console.warn(`HAUNT_STORY_TTL_DAYS="${value}" isn't a number of days; using ${fallback}.`);
    return fallback;
  }
  return Math.floor(days);
}

const defaultHaiku =
  process.env.HAUNT_BEDROCK_API === "converse" ? "us.anthropic.claude-haiku-4-5-20251001-v1:0" : "anthropic.claude-haiku-4-5";

export const config = {
  /** HAUNT_PORT wins so dev tooling that sets PORT for the web app can't collide with the API. */
  port: Number(process.env.HAUNT_PORT ?? process.env.PORT ?? 3001),
  production: process.env.NODE_ENV === "production",
  /** Who writes scenes: Claude on Bedrock, or the offline mock. */
  storyBackend,
  /** Who plays the simulated Alexa+ assistant. Defaults to the story backend. */
  agentBackend: backend(process.env.HAUNT_AGENT, storyBackend),
  /** Who narrates: Amazon Polly, or the browser's built-in voice. */
  ttsBackend: process.env.HAUNT_TTS === "browser" ? "browser" : "polly",
  /**
   * Server speech recognition for recorded answers: "off" (default), "mock" (fixed offline
   * transcript) or "transcribe" (Amazon Transcribe streaming; billed per second of audio).
   */
  sttBackend: (["mock", "transcribe"].includes(process.env.HAUNT_STT ?? "") ? process.env.HAUNT_STT : "off") as
    | "off"
    | "mock"
    | "transcribe",
  /** Extra origins allowed to send recordings, comma-separated (the server's own is always allowed). */
  sttOrigins: (process.env.HAUNT_STT_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  /**
   * How stories and answer matching reach Bedrock: "mantle" (Anthropic-compatible endpoint, the default)
   * or "converse" (bedrock-runtime Converse API, which takes inference profile ids like "us.anthropic.…").
   */
  bedrockApi: process.env.HAUNT_BEDROCK_API === "converse" ? "converse" : "mantle",
  // The default is Claude Haiku 4.5, the model the deployment plan uses (deploy/express-service.json). Converse takes
  // inference profile ids; the Anthropic-compatible endpoint takes the plain model id. Both stay overridable.
  storyModel: process.env.HAUNT_STORY_MODEL ?? defaultHaiku,
  agentModel: process.env.HAUNT_AGENT_MODEL ?? defaultHaiku,
  /** Daily cap on paid calls across every instance (DynamoDB counter). Enforced for signed-in users in production. */
  dailyTtsRequests: Number(process.env.HAUNT_DAILY_TTS_REQUESTS ?? 2000),
  dailyAgentRequests: Number(process.env.HAUNT_DAILY_AGENT_REQUESTS ?? 1000),
  /** Per signed-in listener, per day: one account can't use up the shared caps. */
  dailyUserTtsRequests: Number(process.env.HAUNT_DAILY_USER_TTS_REQUESTS ?? 400),
  dailyUserAgentRequests: Number(process.env.HAUNT_DAILY_USER_AGENT_REQUESTS ?? 200),
  /** First deployment only, before HAUNT_PUBLIC_URL exists: serves the health probes and nothing else. */
  bootstrap: process.env.HAUNT_BOOTSTRAP === "1",
  /** Pre-write a branch per suggested answer, so matching answers continue instantly. */
  prewrite: process.env.HAUNT_PREWRITE !== "off",
  /** Small, fast model that decides whether a spoken answer matches a pre-written branch. */
  matchModel: process.env.HAUNT_MATCH_MODEL ?? "anthropic.claude-haiku-4-5",
  /** Used only if the primary model declines a request. */
  fallbackModel: process.env.HAUNT_FALLBACK_MODEL ?? "anthropic.claude-opus-5-5",
  pollyVoice: process.env.HAUNT_POLLY_VOICE ?? "Kenneth",
  pollyEngine: process.env.HAUNT_POLLY_ENGINE ?? "generative",
  /** Narration as SSML (pauses between paragraphs, careful dashes). "off" sends plain text. */
  pollySsml: process.env.HAUNT_POLLY_SSML !== "off",
  /** Language for Polly. Must match the voice (Matthew is en-US). */
  pollyLanguage: process.env.HAUNT_POLLY_LANGUAGE ?? "en-US",
  /** Where stories and the library live: local JSON files, or one DynamoDB table. */
  store: process.env.HAUNT_STORE === "dynamodb" ? "dynamodb" : "file",
  table: process.env.HAUNT_TABLE_NAME ?? process.env.HAUNT_TABLE ?? "haunt-stories",
  /** Listener profiles, keyed by Cognito `sub` (see profiles.ts and deploy/haunt-users-table.json). */
  usersTable: process.env.HAUNT_USERS_TABLE ?? "haunt-users",
  /**
   * Where likes and progress live. "legacy" (the default) keeps them in the maps in haunt-users, as before. "dual" reads the new
   * haunt-likes and haunt-progress tables first and falls back to the maps, and writes to the new tables only (split-records.ts).
   */
  recordsMode: process.env.HAUNT_RECORDS === "dual" ? ("dual" as const) : ("legacy" as const),
  likesTable: process.env.HAUNT_LIKES_TABLE ?? "haunt-likes",
  /** Statistics and playback counters (stat# totals and play# records). Keys are unchanged from the stories table. */
  statsTable: process.env.HAUNT_STATS_TABLE ?? "haunt-stats",
  /** Shared rate-limit counters (sign-in codes and paid daily caps). Each item has an expiresAt TTL. */
  rateLimitTable: process.env.HAUNT_RATE_LIMIT_TABLE ?? "haunt-auth-rate-limits",
  /** A listener's own stories and their publish state (My Stories, Community). Keyed by owner. */
  userStoriesTable: process.env.HAUNT_USER_STORIES_TABLE ?? "haunt-user-stories",
  /** Admin review decisions for My Stories (story-approvals.ts). Separate from the stories table. */
  storyApprovalsTable: process.env.HAUNT_STORY_APPROVALS_TABLE ?? "haunt-story-approvals",
  progressTable: process.env.HAUNT_PROGRESS_TABLE ?? "haunt-progress",
  /** DynamoDB only: delete stories this many days after their last turn (0 keeps them). Library episodes never expire. */
  storyTtlDays: ttlDays(process.env.HAUNT_STORY_TTL_DAYS),
  dataDir: process.env.HAUNT_DATA_DIR ?? path.join(ROOT_DIR, "data"),
  /**
   * Bearer tokens accepted on /mcp from external MCP clients, comma-separated (supports rotation).
   * In production /mcp is closed when none are set; in development it is open on localhost.
   */
  mcpTokens: (process.env.HAUNT_MCP_TOKENS ?? "").split(",").map((t) => t.trim()).filter((t) => t.length >= 16),
  /**
   * Amazon Cognito user pool that signs listeners in (e.g. "us-east-1_AbC123") and its app client id.
   * Without them, nobody is signed in, except the development stand-in described in auth.ts.
   */
  cognitoUserPoolId: process.env.HAUNT_COGNITO_USER_POOL_ID || undefined,
  cognitoClientId: process.env.HAUNT_COGNITO_CLIENT_ID || undefined,
  /** Offline sign-in with codes printed to the console instead of a user pool. Development only. */
  authMock,
  /**
   * Public address of this site, for the "scan to sign in" link shown on TVs (e.g.
   * https://haunt.example.com). Defaults to the address the TV used to reach the server.
   */
  publicUrl: process.env.HAUNT_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
  /** Members of this Cognito group may approve and reject stories. */
  adminGroup: process.env.HAUNT_ADMIN_GROUP || "haunt-admins",
  /**
   * Migration switch (docs/RBAC.md section 5). While "on" (the default), members of the Cognito admin group keep
   * admin access, so no current admin is locked out. Set "off" once every admin has the ADMIN profile role.
   */
  legacyAdminGroup: process.env.HAUNT_LEGACY_ADMIN_GROUP !== "off",
  /** DynamoDB only: the ownerId/updatedAt index for "My Stories". Scans without it. */
  ownerIndex: process.env.HAUNT_OWNER_INDEX || undefined,
  /** Bearer token for the publishing API, alongside the admin group. Disabled when unset. */
  skillFile: path.join(ROOT_DIR, "skills/haunt/SKILL.md"),
  viewsDir: path.join(ROOT_DIR, "apps/views/dist"),
  webDir: path.join(ROOT_DIR, "apps/web/dist"),
  /** The Fire TV app's production build (vite base /fire-tv/). */
  tvDir: path.join(ROOT_DIR, "apps/tv/dist"),
} as const;
