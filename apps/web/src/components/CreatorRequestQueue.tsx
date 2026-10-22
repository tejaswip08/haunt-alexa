import { useCallback, useEffect, useState } from "react";
import {
  AccessError,
  decideCreatorRequest,
  myRole,
  pendingCreatorRequests,
  type PendingCreatorRequest,
} from "../lib/creator-access.ts";

/**
 * The admin queue for Creator access requests. It shows only when the server reports the ADMIN role, and the
 * request list and decisions are checked by the server regardless. One decision runs at a time, and the list is
 * reloaded from the server after each success.
 */
export function CreatorRequestQueue() {
  const [isAdmin, setIsAdmin] = useState<boolean>();
  const [requests, setRequests] = useState<PendingCreatorRequest[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setRequests(await pendingCreatorRequests());
    } catch (e) {
      setRequests([]);
      setError(e instanceof AccessError && e.status === 403 ? "Only Haunt admins can review requests." : (e as Error).message);
    }
  }, []);

  useEffect(() => {
    myRole()
      .then((role) => {
        setIsAdmin(role === "ADMIN");
        if (role === "ADMIN") void load();
      })
      .catch(() => setIsAdmin(false));
  }, [load]);

  if (!isAdmin) return null;

  const decide = async (subject: string, outcome: "approve" | "reject") => {
    if (busy) return;
    setBusy(subject);
    setError(undefined);
    setNotice(undefined);
    try {
      await decideCreatorRequest(subject, outcome);
      setNotice(outcome === "approve" ? "Creator access approved." : "Request rejected.");
      await load();
    } catch (e) {
      setError((e as Error).message || "That decision didn't go through. Try again.");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="card" aria-label="Creator requests">
      <h2>Creator requests</h2>
      <p className="signin-hint">Listeners who asked to create stories. Approving makes an account a Creator.</p>
      {!requests ? (
        <p className="signin-hint">Loading requests…</p>
      ) : requests.length === 0 ? (
        !error && <p className="signin-hint">No requests are waiting.</p>
      ) : (
        <ul className="admin-list">
          {requests.map((r) => (
            <li key={r.subject} className="admin-row">
              <span>
                {r.displayName ?? r.email ?? "Listener account"} · requested {new Date(r.requestedAt).toLocaleDateString()}
              </span>
              {busy === r.subject ? (
                <span className="signin-hint">Saving…</span>
              ) : (
                <span className="admin-actions">
                  <button type="button" className="ghost small" onClick={() => void decide(r.subject, "approve")}>
                    Approve
                  </button>
                  <button type="button" className="ghost small" onClick={() => void decide(r.subject, "reject")}>
                    Reject
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="signin-hint" role="status">{notice}</p>}
      {error && (
        <p className="signin-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="ghost small" onClick={() => void load()}>
        Refresh
      </button>
    </section>
  );
}
