import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AccessError,
  myCreatorRequest,
  myRole,
  requestCreatorAccess,
  type AccountRole,
  type CreatorRequestView,
} from "../lib/creator-access.ts";

/**
 * The listener's Creator access: their role and request status, and a request button when none is pending.
 * The server decides everything shown here. The button is a convenience; the server refuses a second pending request.
 */
export function CreatorAccessPanel() {
  const [role, setRole] = useState<AccountRole>();
  const [request, setRequest] = useState<CreatorRequestView | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [currentRole, current] = await Promise.all([myRole(), myCreatorRequest()]);
      setRole(currentRole);
      setRequest(current);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ask = async () => {
    if (busy || request?.status === "PENDING") return;
    setBusy(true);
    setError(undefined);
    try {
      setRequest(await requestCreatorAccess());
    } catch (e) {
      setError(e instanceof AccessError ? e.message : "Your request didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (!role && !error) {
    body = <p className="signin-hint">Loading your access…</p>;
  } else if (role === "ADMIN") {
    body = <p>You are a Haunt admin. Review requests and submissions on the publishing desk.</p>;
  } else if (role === "CREATOR") {
    body = <p>You are a Creator. Your stories can be submitted for review.</p>;
  } else if (request?.status === "PENDING") {
    body = <p>Your request is waiting for an admin. You'll see the result here.</p>;
  } else if (request?.status === "APPROVED") {
    body = <p>Your request was approved. Sign in again to refresh your access.</p>;
  } else {
    body = (
      <>
        <p>
          {request?.status === "REJECTED"
            ? "Your last request wasn't approved. You can ask again."
            : "Creators can write stories and submit them for review. Requesting access grants nothing until an admin approves."}
        </p>
        {request?.status === "REJECTED" && request.reason && <p className="signin-hint">Reason: {request.reason}</p>}
        <button type="button" className="ghost small" onClick={() => void ask()} disabled={busy}>
          {busy ? "Sending…" : "Request Creator access"}
        </button>
      </>
    );
  }

  return (
    <section className="card" aria-label="Creator access">
      <h2>Creator access</h2>
      {body}
      {error && (
        <p className="signin-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
