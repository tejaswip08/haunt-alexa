import { existsSync } from "node:fs";
import path from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { activatePage } from "./activate-page.ts";
import { adminRouter, setAdminProfiles } from "./admin.ts";
import { authenticatorFor, identify } from "./auth.ts";
import { createAuthRouter } from "./auth-route.ts";
import { createCognitoClient } from "./cognito-client.ts";
import { meRouter } from "./me.ts";
import { originalsRouter } from "./originals.ts";
import { createMockAuth } from "./mock-auth.ts";
import { AgentRequestSchema, runAgentTurn } from "./agent.ts";
import { describeAwsError } from "./aws-errors.ts";
import { config, dynamoCredentials, ROOT_DIR } from "./config.ts";
import { createHauntMcpServer } from "./mcp.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { createMockSpeechToText, createTranscribeSpeechToText } from "./stt.ts";
import { createMcpRouter } from "./mcp-route.ts";
import { rateLimit } from "./request-guards.ts";
import { dynamo, engine, library } from "./stories.ts";
import { authorizeStoryWrite } from "./story-write-access.ts";
import { createSettingsGenerator } from "./story-regenerate.ts";
import { engagement } from "./engagement.ts";
import { createEngagementRouter } from "./library-engagement.ts";
import { createTrendingRouter } from "./trending-route.ts";
import { dynamoPlaySource } from "./trending.ts";
import { createFeaturedAdminRouter, createFeaturedPublicRouter } from "./featured-route.ts";
import { dynamoFeaturedStore } from "./featured.ts";

import { createVoiceLabRouter } from "./voice-lab.ts";
import { createCommunityRouter, createCoverRouter, createCreatorStoryRouter } from "./user-stories-route.ts";
import { StoryApprovalStore } from "./story-approvals.ts";
import { DEV_IDENTITIES, type DevIdentity } from "./dev-identities.ts";
import { createStoryReviewRouter, isNamedAdmin } from "./story-review-route.ts";
import { coverStorageFromEnv } from "./covers.ts";
import { UserStoryStore } from "./user-stories.ts";
import { createMyLibraryRouter } from "./me-library.ts";
import { ViewingStore } from "./viewing.ts";
import { SplitStore } from "./split-records.ts";
import { createSharedLimiter } from "./otp-limits.ts";
import { ProfileStore } from "./profiles.ts";
import { createUsersRouter } from "./users.ts";
import { CreatorAccessStore, createCreatorAccessRouter } from "./creator-access.ts";
import { ADMIN_ROLES, CREATOR_ROLES, requireRole, roleOf } from "./roles.ts";
import { DynamoDBClient as UsersDynamoClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient as UsersDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Profiles live in their own table. Without DynamoDB (development), profile routes answer 503. */
const usersDoc = dynamo
  ? UsersDocumentClient.from(new UsersDynamoClient({ region: config.awsRegion, maxAttempts: 4, credentials: dynamoCredentials() }), {
      marshallOptions: { removeUndefinedValues: true },
    })
  : undefined;
const profileStore = usersDoc ? new ProfileStore(usersDoc, config.usersTable) : undefined;
/** Who may change stories through MCP: see story-write-access.ts. */
const authorizeStory = (user: { sub: string } | undefined, tool: string, external: boolean) =>
  authorizeStoryWrite(user, tool, external, config.production);

/** Creator access requests and role decisions, in the same table (creator-access.ts). */
const creatorAccess = usersDoc && profileStore ? new CreatorAccessStore(usersDoc, config.usersTable, profileStore) : undefined;
import { createTranscribeRouter } from "./transcribe-route.ts";
import { MAX_TTS_CHARS, synthesize } from "./tts.ts";

const app = createMcpExpressApp({ host: "0.0.0.0", jsonLimit: "1mb" });
// Behind one load balancer (e.g. ECS Express Mode), trust it for the client IP, so rate
// limits apply per visitor rather than to the balancer. Off by default.
if (process.env.HAUNT_TRUST_PROXY === "1") app.set("trust proxy", 1);

// First deployment only (HAUNT_BOOTSTRAP=1, see config.ts): until the public address is set, nothing but the health probes
// answers. Everything else is refused, so a half-configured service can't serve listeners or spend money.
if (config.bootstrap) {
  app.use((req, res, next) => {
    if (req.path === "/api/health" || req.path === "/api/ready") return next();
    res.status(503).json({ error: "Haunt is being set up. Try again shortly." });
  });
}

/** HAUNT_AUTH=mock: offline sign-in with codes printed to this console (development only). */
const mockAuth = config.authMock ? createMockAuth() : undefined;

/** Hosts that mean "this machine": DynamoDB Local, never a real AWS endpoint. */
function isLocalEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}
/** The one-click test login: only in isolated mock mode with DynamoDB Local. Never with Cognito or live AWS. */
const devTestLoginEnabled = Boolean(mockAuth) && !config.production && Boolean(dynamo) && isLocalEndpoint(process.env.AWS_ENDPOINT_URL_DYNAMODB);
/**
 * The two local role identities (dev-identities.ts). Enabled only with the same guard as the test login. Provisioning creates
 * a missing profile with the identity's role and never changes an existing one (profiles.ts, provisionRole).
 */
const devSignIn =
  devTestLoginEnabled && mockAuth && profileStore
    ? async (identity: DevIdentity) => {
        const dev = DEV_IDENTITIES[identity];
        await profileStore.provisionRole(dev.sub, dev.role);
        return mockAuth.devLoginAs(dev.email, dev.sub);
      }
    : undefined;
const cognito = mockAuth
  ? mockAuth.cognito
  : // Both are needed: the client id to sign in, the pool id to verify the tokens it returns.
    config.cognitoClientId && config.cognitoUserPoolId
    ? createCognitoClient({ region: config.awsRegion, clientId: config.cognitoClientId })
    : undefined;

/** Signed-in listeners: Cognito access tokens, or a development stand-in locally (see auth.ts). */
const authenticate = mockAuth?.authenticate ?? authenticatorFor(config);

// ---------- MCP endpoint (Streamable HTTP, stateless) ----------

// External MCP clients: bearer token (HAUNT_MCP_TOKENS); open only in local development.
app.use(
  "/mcp",
  createMcpRouter({
    access: { kind: "external", tokens: config.mcpTokens, production: config.production },
    createServer: createHauntMcpServer,
    authorizeTool: authorizeStory,
    // Per IP. One MCP turn is ~3 requests (initialize, notification, tool call).
    limiter: createRateLimiter([
      { windowMs: 60_000, max: 120 },
      { windowMs: 3_600_000, max: 2_000 },
    ]),
  }),
);

// Haunt's own /play and /tv pages. They are public web pages and can't hold a secret, so this
// route accepts same-origin requests only and is rate-limited like the rest of the public site.
app.use(
  "/api/mcp",
  createMcpRouter({
    access: { kind: "first-party", extraOrigins: config.sttOrigins },
    createServer: createHauntMcpServer,
    authorizeTool: authorizeStory,
    authenticate,
    guests: { secure: config.production },
    limiter: createRateLimiter([
      { windowMs: 60_000, max: 120 },
      { windowMs: 3_600_000, max: 2_000 },
    ]),
  }),
);

// ---------- Simulator APIs ----------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mcp: { path: "/mcp", transport: "streamable-http", protocolVersion: LATEST_PROTOCOL_VERSION },
    story: config.storyBackend === "mock" ? "mock" : `bedrock:${config.storyModel}`,
    agent: config.agentBackend === "mock" ? "mock" : `bedrock:${config.agentModel}`,
    /** "demo" means scripted stand-ins answer instead of Claude; the simulator shows a badge. */
    mode: { story: config.storyBackend === "mock" ? "demo" : "live", agent: config.agentBackend === "mock" ? "demo" : "live" },
    tts: config.ttsBackend === "browser" ? "browser" : `polly:${config.pollyVoice}/${config.pollyEngine}`,
    /** Server speech recognition for recorded answers: "off", "mock" or "transcribe". */
    stt: config.sttBackend,
    store: config.store,
    /** "email-otp" once a Cognito user pool is configured; "off" means everyone plays as a guest. */
    signIn: cognito ? "email-otp" : "off",
    /** True when sign-in is the offline stand-in (HAUNT_AUTH=mock): codes appear in the server console. */
    authMock: Boolean(mockAuth),
    testLogin: devTestLoginEnabled,
    /** "token" (external clients need a bearer token), "open" (local development) or "closed". */
    mcpAuth: config.mcpTokens.length ? "token" : config.production ? "closed" : "open",
  });
});

/**
 * Production: the paid routes need a signed-in listener, and a daily count shared by every instance (DynamoDB), so the
 * cap holds across tasks. If the count can't be checked, the call is refused (fail closed). Development stays open.
 */
const dailyCounter = dynamo ? createSharedLimiter(dynamo, config.rateLimitTable) : undefined;
function paidDailyCap(scope: string, limit: number, userLimit: number): RequestHandler {
  return async (_req, res, next) => {
    if (!config.production) return next();
    const user = res.locals.user as { sub: string } | undefined;
    if (!user) return void res.status(401).json({ error: "Sign in to use this." });
    if (!dailyCounter) return void res.status(503).json({ error: "This is unavailable right now." });
    try {
      // Per listener first, so one account can't use up the shared cap. The key holds the account id, never a name or email.
      const mine = await dailyCounter.hit(`${scope}-user-${user.sub}`, userLimit, 86_400);
      if (!mine.ok) {
        res.set("Retry-After", String(mine.retryAfterSeconds)).status(429).json({ error: "You've reached today's limit. Try again tomorrow." });
        return;
      }
      const shared = await dailyCounter.hit(scope, limit, 86_400);
      if (!shared.ok) {
        res.set("Retry-After", String(shared.retryAfterSeconds)).status(429).json({ error: "The daily limit is reached. Try again tomorrow." });
        return;
      }
      next();
    } catch (error) {
      console.error(`[limit] ${scope} check failed:`, (error as Error).name);
      res.status(503).json({ error: "This is unavailable right now." });
    }
  };
}

// Each call can reach Bedrock or Polly, which are billed; limit per IP.
const agentLimit = rateLimit(createRateLimiter([{ windowMs: 60_000, max: 30 }, { windowMs: 3_600_000, max: 400 }]), () => ({
  error: "Too many requests. Wait a moment.",
}));
const ttsLimit = rateLimit(createRateLimiter([{ windowMs: 60_000, max: 40 }, { windowMs: 3_600_000, max: 600 }]), () => ({
  error: "Too many requests. Wait a moment.",
}));

/** Readiness: can this instance reach its story store? (Health only says the process is up.) */
app.get("/api/ready", async (_req, res) => {
  try {
    await engine.store.get("readiness-probe");
    res.json({ ready: true, store: config.store });
  } catch (error) {
    console.error("[ready] store check failed:", (error as Error).name);
    res.status(503).json({ ready: false, store: config.store });
  }
});

app.post("/api/agent", identify(authenticate), paidDailyCap("agent", config.dailyAgentRequests, config.dailyUserAgentRequests), agentLimit, async (req, res) => {
  const parsed = AgentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  try {
    res.json(await runAgentTurn(parsed.data));
  } catch (error) {
    console.error("[agent] turn failed:", error);
    const { status, reason } = describeAwsError(error, "The assistant");
    res.status(status).json({ error: reason });
  }
});

const TtsRequestSchema = z.object({ text: z.string().min(1).max(MAX_TTS_CHARS) });

// Voice audition (development only): off unless HAUNT_VOICE_LAB=1, and never in production.
if (process.env.HAUNT_VOICE_LAB === "1" && !config.production) {
  app.use("/api/voice-lab", createVoiceLabRouter());
  app.use("/voice-lab", express.static(path.join(ROOT_DIR, "apps/server/voice-lab")));
}

app.post("/api/tts", identify(authenticate), paidDailyCap("tts", config.dailyTtsRequests, config.dailyUserTtsRequests), ttsLimit, async (req, res) => {
  if (config.ttsBackend === "browser") {
    res.status(503).json({ error: "Server narration is off; use the browser voice." });
    return;
  }
  const parsed = TtsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  try {
    const audio = await synthesize(parsed.data.text);
    if (!config.production) console.info(`[tts] 200 audio/mpeg ${audio.length} bytes for ${parsed.data.text.length} chars`);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(audio));
  } catch (error) {
    console.error("[tts] synthesis failed:", error);
    const { status, reason } = describeAwsError(error, "Narration");
    res.status(status).json({ error: reason });
  }
});

app.use(
  "/api/transcribe",
  createTranscribeRouter({
    speechToText:
      config.sttBackend === "mock"
        ? createMockSpeechToText()
        : config.sttBackend === "transcribe"
          ? createTranscribeSpeechToText({ region: config.awsRegion })
          : undefined,
    // Per IP: 6 answers a minute, 60 an hour. A story needs one every ~30 seconds at most.
    limiter: createRateLimiter([
      { windowMs: 60_000, max: 6 },
      { windowMs: 3_600_000, max: 60 },
    ]),
    extraOrigins: config.sttOrigins,
  }),
);

// Passwordless email sign-in (Cognito EMAIL_OTP). Answers 404 until a user pool is configured.
app.use(
  "/api/auth",
  createAuthRouter({
    devTestLogin: devTestLoginEnabled ? mockAuth?.devLogin : undefined,
    devSignIn,
    cognito,
    secureCookies: config.production,
    publicUrl: config.publicUrl,
    adminGroup: config.adminGroup,
    extraOrigins: config.sttOrigins,
    // Shared across instances when the store is DynamoDB; in development the in-memory limits apply alone.
    shared: dynamo ? createSharedLimiter(dynamo, config.rateLimitTable) : undefined,
    profiles: profileStore,
  }),
);
// Submitting a story for review is a Creator action. The role is checked here, before the route's
// own ownership and status checks in me.ts.
app.post("/api/me/stories/:storyId/submit", identify(authenticate), requireRole(profileStore, CREATOR_ROLES));
// Moving guest stories into an account changes their owner, so it's a Creator action too.
app.post("/api/me/claim-guest-stories", identify(authenticate), requireRole(profileStore, CREATOR_ROLES));
app.use("/api/me", identify(authenticate), meRouter);
// Creator access: a listener asks for it, and an admin decides (creator-access.ts).
app.use("/api/creator-access", identify(authenticate), createCreatorAccessRouter(creatorAccess, profileStore));
// The signed-in listener's profile (users.ts). Needs a signed-in user for every route.
app.use("/api/users", identify(authenticate), createUsersRouter(profileStore));

// Phone page for TV sign-in: the TV shows a QR code that opens this with its code.
app.get("/activate", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(activatePage);
});
// Admin routes: the profile role is the authority, with the Cognito group accepted during migration (admin.ts, docs/RBAC.md).
setAdminProfiles(profileStore);
const userStories = dynamo ? new UserStoryStore(dynamo, config.userStoriesTable) : undefined;
// Admin approval for My Stories: decisions live in their own table, and a story goes public only through approve().
const storyApprovals = dynamo && userStories ? new StoryApprovalStore(dynamo, config.storyApprovalsTable, config.userStoriesTable, userStories) : undefined;
if (storyApprovals && userStories) {
  app.use(
    "/api/admin/story-submissions",
    identify(authenticate),
    createStoryReviewRouter({ approvals: storyApprovals, stories: userStories, profiles: profileStore, legacyAdmin: config.legacyAdminGroup }),
  );
}

// Trending and Featured Tonight (trending-route.ts, featured-route.ts). Both are off until their switches are on, and each
// answers 503 with a plain message while off. Writes to Featured Tonight are admin-only (the ADMIN role, checked per request).
// Only a published story can trend or be featured.
const trendingOn = process.env.HAUNT_TRENDING === "on";
const featuredOn = process.env.HAUNT_FEATURED === "on";
const isPublishedStory = async (storyId: string): Promise<boolean> => {
  if (await library.get(storyId)) return true;
  return Boolean(userStories && (await userStories.findPublished(storyId)));
};
app.use(
  "/api/trending",
  createTrendingRouter({ enabled: trendingOn, source: dynamo ? dynamoPlaySource(dynamo, config.statsTable) : undefined, isEligible: isPublishedStory }),
);
app.use(
  "/api/featured",
  createFeaturedPublicRouter({ enabled: featuredOn, store: dynamo ? dynamoFeaturedStore(dynamo, config.statsTable) : undefined, isPublished: isPublishedStory }),
);
app.use(
  "/api/admin/featured",
  identify(authenticate),
  createFeaturedAdminRouter({
    enabled: featuredOn,
    store: dynamo ? dynamoFeaturedStore(dynamo, config.statsTable) : undefined,
    isPublished: isPublishedStory,
    adminOnly: requireRole(profileStore, ADMIN_ROLES),
  }),
);
app.use("/api/admin", identify(authenticate), adminRouter);

// Haunt Original stories: public read-only, for guests and listeners alike (see originals.ts).
const originalsLimit = rateLimit(createRateLimiter([{ windowMs: 60_000, max: 120 }, { windowMs: 3_600_000, max: 3_000 }]), () => ({
  error: "Too many requests. Wait a moment.",
}));
app.use("/api/originals", originalsLimit, originalsRouter);
// The signed-in listener's Continue Watching and My Likes (me-library.ts). Mounted before /api/me, which guards its own paths.
const viewing = usersDoc ? new ViewingStore(usersDoc, config.usersTable) : undefined;
// The split likes and progress tables. Likes always use haunt-likes (every like and unlike is written there); progress and the
// My Likes merge use it only in dual mode (HAUNT_RECORDS=dual). The legacy maps stay the default for progress.
const likeStore =
  dynamo && viewing
    ? new SplitStore(dynamo, { likes: config.likesTable, progress: config.progressTable, stories: config.table, stats: config.statsTable }, async (sub) => (await viewing.get(sub)).likes)
    : undefined;
const splitRecords = config.recordsMode === "dual" ? likeStore : undefined;
app.use(
  "/api/me/library",
  identify(authenticate),
  createMyLibraryRouter(viewing, library, engagement, createRateLimiter([{ windowMs: 60_000, max: 30 }]), splitRecords, likeStore),
);
// My Stories (haunt-user-stories) and Community (production plus published community stories). Owner from the session only.
// Cover images: a private bucket (HAUNT_COVER_BUCKET). Readers are redirected to short-lived signed links (covers.ts).
const coverStorage = coverStorageFromEnv();
// Creator story management: signed in AND a creator role (CREATOR or ADMIN). Listeners get 403 here.
app.use(
  "/api/me/user-stories",
  createCreatorStoryRouter({
    authenticate,
    profiles: profileStore,
    store: userStories,
    limiter: createRateLimiter([{ windowMs: 60_000, max: 60 }]),
    covers: coverStorage,
    approvals: storyApprovals,
    generate: createSettingsGenerator(engine),
  }),
);
// Cover reads: the viewer is identified when a token is sent, and each read is authorized against its story (mayReadCover).
if (userStories) {
  app.use(
    "/api/covers",
    identify(authenticate),
    createCoverRouter({
      storage: coverStorage,
      stories: userStories,
      approvals: storyApprovals,
      isAdmin: (user) => isNamedAdmin(user, profileStore, config.legacyAdminGroup),
    }),
  );
}
app.use("/api/community", createCommunityRouter(library, userStories));

// Likes and play counts (library-engagement.ts). Writes are per-IP limited there; the user comes from the session.
app.use(
  "/api/library",
  identify(authenticate),
  createEngagementRouter(engagement, library, createRateLimiter([{ windowMs: 60_000, max: 60 }]), likeStore, userStories),
);

// The Haunt Agent Skill, for any agent that supports Agent Skills.
app.get("/skills/haunt/SKILL.md", (_req, res) => {
  res.type("text/markdown").sendFile(config.skillFile);
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---------- Web app (production build) ----------

// The Fire TV app, same origin as the API (so its bearer-token calls need no CORS). Only /fire-tv/ is handled here, so
// the API routes above and the web app below are unaffected.
if (existsSync(config.tvDir)) {
  app.use("/fire-tv", express.static(config.tvDir, { index: false }));
  app.get(/^\/fire-tv(\/.*)?$/, (req, res) => {
    // A missing file (for example a script or image) is a 404, not the app's HTML. Client-side routes have no extension.
    if (path.extname(req.path)) return void res.status(404).json({ error: "No such file." });
    res.sendFile(path.join(config.tvDir, "index.html"));
  });
}
if (existsSync(config.webDir)) {
  app.use(express.static(config.webDir, { index: false }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(config.webDir, "index.html")));
}

// 0.0.0.0 so the platform router (Render) can reach the process; the port comes from config.
// Lambda (lambda.ts) imports `app` and serves requests itself; only a local or container start listens on a port.
export { app };

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
const server = app.listen(config.port, "0.0.0.0", (error) => {
  if (error) {
    console.error("Failed to start:", error);
    process.exit(1);
  }
  console.log(`Haunt server on http://localhost:${config.port}`);
  console.log(`  MCP endpoint  http://localhost:${config.port}/mcp  (protocol ${LATEST_PROTOCOL_VERSION})`);
  console.log(`  story: ${config.storyBackend}  agent: ${config.agentBackend}  tts: ${config.ttsBackend}  stt: ${config.sttBackend}`);
  console.log(`  sign-in: ${mockAuth ? "MOCK (codes print here, development only)" : cognito ? "Cognito email codes" : "off (everyone is a guest)"}`);
});

// Whole-request and header deadlines, so slow or stuck clients can't hold connections open.
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
if (config.mcpTokens.length === 0) {
  console.log(
    config.production
      ? "  /mcp is CLOSED: set HAUNT_MCP_TOKENS to let external MCP clients connect."
      : "  /mcp is OPEN without a token (development only; production requires HAUNT_MCP_TOKENS).",
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
}
