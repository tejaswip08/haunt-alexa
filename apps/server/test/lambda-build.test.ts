import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

// The production Lambda artifact, built by scripts/build-lambda.mjs into a temporary directory (the deployment directory is not
// touched). The bundle must contain the approval, cover, and S3 code, the scene asset, and must start with no node_modules.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let out = "";

before(() => {
  out = mkdtempSync(path.join(tmpdir(), "haunt-lambda-test-"));
  execFileSync(process.execPath, [path.join(repo, "scripts/build-lambda.mjs"), out], { cwd: repo, stdio: "pipe" });
});
after(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("the Lambda artifact layout", () => {
  it("has the bundle, the scene asset, and the package type at the paths the runtime expects", () => {
    assert.ok(existsSync(path.join(out, "apps/server/src/lambda.js")), "handler file for apps/server/src/lambda.handler");
    assert.ok(existsSync(path.join(out, "apps/views/dist/scene.html")), "scene asset read from ROOT_DIR/apps/views/dist");
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, "package.json"), "utf8")), { type: "module" });
  });

  it("contains the approval routes, the cover routes, and the S3 and presign code", () => {
    const bundle = readFileSync(path.join(out, "apps/server/src/lambda.js"), "utf8");
    assert.match(bundle, /story-submissions/, "approval review routes");
    assert.match(bundle, /mayReadCover/, "cover read authorization");
    assert.match(bundle, /covers\//, "cover key layout");
    assert.match(bundle, /S3Client/, "S3 SDK client");
    assert.match(bundle, /createPresignedPost/, "presigned upload packages");
    assert.match(bundle, /serverless-express/, "Lambda wrapper");
  });
});

describe("the bundle runs without node_modules", () => {
  it("starts from an empty directory and answers HTTP API events", () => {
    const probe = `
      import { handler } from ${JSON.stringify(path.join(out, "apps/server/src/lambda.js"))};
      const event = (path) => ({ version: "2.0", routeKey: "$default", rawPath: path, rawQueryString: "", headers: {}, isBase64Encoded: false,
        requestContext: { http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "t" }, requestId: "1", routeKey: "$default", stage: "$default", time: "", timeEpoch: 0, accountId: "1", apiId: "1", domainName: "x", domainPrefix: "x" } });
      const ctx = { callbackWaitsForEmptyEventLoop: false, functionName: "t", awsRequestId: "1", getRemainingTimeInMillis: () => 1000 };
      const admin = await handler(event("/api/admin/story-submissions"), ctx);
      const cover = await handler(event("/api/covers/covers/a/b/c.png"), ctx);
      console.log(JSON.stringify({ admin: admin.statusCode, cover: cover.statusCode }));
      process.exit(0);`;
    const probeFile = path.join(out, "probe.mjs");
    writeFileSync(probeFile, probe);
    const run = spawnSync(process.execPath, [probeFile], {
      cwd: out,
      env: { ...process.env, NODE_PATH: "", HAUNT_STORE: "dynamodb", HAUNT_AUTH: "mock", NODE_ENV: "development", AWS_ENDPOINT_URL_DYNAMODB: "http://127.0.0.1:9", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const lastLine = run.stdout.trim().split("\n").pop()!;
    // Anonymous admin review is refused; a cover with no bucket configured is 503. Both answer without a stack trace.
    assert.deepEqual(JSON.parse(lastLine), { admin: 403, cover: 503 });
    assert.doesNotMatch(run.stderr, /Cannot find (package|module)/);
  });
});
