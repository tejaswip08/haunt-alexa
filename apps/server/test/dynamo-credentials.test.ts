import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dynamoCredentials } from "../src/config.ts";

// Local DynamoDB uses one fixed key; real AWS never gets it. Bedrock is separate and is not touched by this.
const original = process.env.AWS_ENDPOINT_URL_DYNAMODB;
afterEach(() => {
  if (original === undefined) delete process.env.AWS_ENDPOINT_URL_DYNAMODB;
  else process.env.AWS_ENDPOINT_URL_DYNAMODB = original;
});

describe("DynamoDB credentials", () => {
  it("uses the fixed local key for a DynamoDB Local endpoint, so the tables stay reachable with any AWS login", () => {
    process.env.AWS_ENDPOINT_URL_DYNAMODB = "http://localhost:8001";
    assert.deepEqual(dynamoCredentials(), { accessKeyId: "local", secretAccessKey: "local" });
  });

  it("never sets a key for a real AWS endpoint, or when no endpoint is set", () => {
    delete process.env.AWS_ENDPOINT_URL_DYNAMODB;
    assert.equal(dynamoCredentials(), undefined);
    process.env.AWS_ENDPOINT_URL_DYNAMODB = "https://dynamodb.us-east-1.amazonaws.com";
    assert.equal(dynamoCredentials(), undefined);
  });
});
