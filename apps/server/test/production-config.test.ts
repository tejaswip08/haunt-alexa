import assert from "node:assert/strict";
import { test } from "node:test";
import { productionProblems } from "../src/config.ts";

/** A production environment that passes every rule. Each test changes one setting from this. */
const complete = {
  NODE_ENV: "production",
  HAUNT_STORE: "dynamodb",
  HAUNT_PROVIDER: "bedrock",
  HAUNT_AGENT: "bedrock",
  HAUNT_TTS: "polly",
  HAUNT_BEDROCK_API: "converse",
  HAUNT_COGNITO_USER_POOL_ID: "us-east-1_example",
  HAUNT_COGNITO_CLIENT_ID: "client-example",
  HAUNT_PUBLIC_URL: "https://haunt.example.com",
};

test("a complete production environment has no problems", () => {
  assert.deepEqual(productionProblems(complete), []);
});

test("production requires the DynamoDB store", () => {
  assert.ok(productionProblems({ ...complete, HAUNT_STORE: "file" }).some((p) => p.includes("HAUNT_STORE")));
  assert.ok(productionProblems({ ...complete, HAUNT_STORE: undefined }).some((p) => p.includes("HAUNT_STORE")));
});

test("production refuses mock AI and speech stand-ins", () => {
  const problems = productionProblems({ ...complete, HAUNT_PROVIDER: "mock", HAUNT_AGENT: "mock", HAUNT_STT: "mock" });
  assert.ok(problems.includes('HAUNT_PROVIDER="mock" is for local development only.'));
  assert.ok(problems.includes('HAUNT_AGENT="mock" is for local development only.'));
  assert.ok(problems.includes('HAUNT_STT="mock" is for local development only.'));
});

test("production requires Polly narration and Cognito sign-in", () => {
  assert.ok(productionProblems({ ...complete, HAUNT_TTS: "browser" }).some((p) => p.includes("HAUNT_TTS")));
  assert.ok(productionProblems({ ...complete, HAUNT_COGNITO_CLIENT_ID: undefined }).some((p) => p.includes("HAUNT_COGNITO_CLIENT_ID")));
});

test("production requires a public https address once bootstrap is over", () => {
  assert.ok(productionProblems({ ...complete, HAUNT_PUBLIC_URL: undefined }).some((p) => p.includes("HAUNT_PUBLIC_URL")));
});

test("development is unrestricted", () => {
  assert.deepEqual(productionProblems({ HAUNT_STORE: "file", HAUNT_PROVIDER: "mock" }), []);
});
