/**
 * Turns AWS SDK and Bedrock errors into a short reason the listener can be told, plus an
 * HTTP status. The full error is still logged on the server; only the reason is returned.
 */
export interface FriendlyError {
  status: number;
  reason: string;
}

export function describeAwsError(error: unknown, service = "The assistant"): FriendlyError {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? "";
  const message = e?.message ?? "";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return { status: 504, reason: `${service} took too long to answer. Please try again.` };
  }
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException" || e?.$metadata?.httpStatusCode === 429) {
    return { status: 429, reason: `${service} is busy right now. Please wait a moment and try again.` };
  }
  if (name === "CredentialsProviderError" || /credential|expired.*token|token.*expired|sso/i.test(message)) {
    return { status: 503, reason: `${service} can't sign in to AWS. The server's AWS credentials are missing or expired.` };
  }
  if (name === "AccessDeniedException" || /not available for this account|not authorized/i.test(message)) {
    return { status: 503, reason: `${service} isn't allowed to use this Bedrock model on this AWS account.` };
  }
  if (name === "ResourceNotFoundException" || (name === "ValidationException" && /model/i.test(message))) {
    return { status: 503, reason: `${service}'s Bedrock model id is wrong or not offered in this region.` };
  }
  return { status: 502, reason: `${service} is unavailable right now.` };
}
