import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apiMessage,
  entryStatus,
  loadSchedule,
  removeSelection,
  saveSelection,
  selectionProblems,
  utcInputFromIso,
  utcIsoFromLocalInput,
} from "../src/lib/featured-admin.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const PUBLISHED = new Set(["story-a"]);
const json = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("UTC times in the admin form", () => {
  it("reads a datetime-local value as UTC, never the viewer's zone", () => {
    assert.equal(utcIsoFromLocalInput("2026-10-22T18:00"), "2026-10-22T18:00:00.000Z");
  });

  it("rejects values that are not a real date and time", () => {
    assert.equal(utcIsoFromLocalInput(""), undefined);
    assert.equal(utcIsoFromLocalInput("2026-13-40T99:00"), undefined);
  });

  it("shows a saved instant back in UTC, so editing round-trips", () => {
    assert.equal(utcInputFromIso("2026-10-22T18:00:00.000Z"), "2026-10-22T18:00");
  });
});

describe("selection validation (mirrors the server's rules)", () => {
  const good = { storyId: "story-a", startsAt: "2026-10-22T13:00:00.000Z", endsAt: "2026-10-22T20:00:00.000Z" };

  it("accepts a published story in a valid future window", () => {
    assert.deepEqual(selectionProblems(good, NOW, PUBLISHED), []);
  });

  it("asks for a story, and refuses one that is not published", () => {
    assert.deepEqual(selectionProblems({ ...good, storyId: "" }, NOW, PUBLISHED), ["Choose a published story."]);
    assert.deepEqual(selectionProblems({ ...good, storyId: "draft" }, NOW, PUBLISHED), ["Only a published story can be featured."]);
  });

  it("asks for both times and an end after the start", () => {
    assert.deepEqual(selectionProblems({ ...good, startsAt: "" }, NOW, PUBLISHED), ["Enter a start time (UTC)."]);
    assert.deepEqual(selectionProblems({ ...good, endsAt: "" }, NOW, PUBLISHED), ["Enter an end time (UTC)."]);
    assert.deepEqual(selectionProblems({ ...good, endsAt: good.startsAt }, NOW, PUBLISHED), ["The end must be after the start."]);
  });

  it("limits a run to 14 days and a lead to 60 days", () => {
    const longRun = { ...good, endsAt: "2026-11-10T13:00:00.000Z" };
    assert.deepEqual(selectionProblems(longRun, NOW, PUBLISHED), ["A feature can run for at most 14 days."]);
    const farAhead = { ...good, startsAt: "2026-12-30T13:00:00.000Z", endsAt: "2026-12-30T20:00:00.000Z" };
    assert.deepEqual(selectionProblems(farAhead, NOW, PUBLISHED), ["A feature can start at most 60 days from now."]);
  });

  it("refuses a window that has already ended", () => {
    const past = { ...good, startsAt: "2026-10-01T13:00:00.000Z", endsAt: "2026-10-02T13:00:00.000Z" };
    assert.deepEqual(selectionProblems(past, NOW, PUBLISHED), ["That window has already ended. Choose a later time."]);
  });
});

describe("entry status", () => {
  const entry = { storyId: "story-a", startsAt: "2026-10-22T12:00:00.000Z", endsAt: "2026-10-22T14:00:00.000Z" };
  it("is live from the start up to, not including, the end", () => {
    assert.equal(entryStatus(entry, Date.parse("2026-10-22T12:00:00Z")), "live");
    assert.equal(entryStatus(entry, Date.parse("2026-10-22T13:59:59Z")), "live");
    assert.equal(entryStatus(entry, Date.parse("2026-10-22T14:00:00Z")), "ended");
  });
  it("is upcoming before the start", () => {
    assert.equal(entryStatus(entry, Date.parse("2026-10-22T11:59:59Z")), "upcoming");
  });
});

describe("API calls and their errors", () => {
  it("sends the schedule version with a save, and returns the new schedule", async () => {
    let sent: { url: string; body: unknown } | undefined;
    const fetcher = async (url: string, init?: RequestInit) => {
      sent = { url, body: JSON.parse(String(init?.body)) };
      return json(200, { version: 4, entries: [] })();
    };
    const result = await saveSelection(fetcher, { storyId: "story-a", startsAt: "a", endsAt: "b" }, 3);
    assert.equal(sent?.url, "/api/admin/featured");
    assert.deepEqual(sent?.body, { storyId: "story-a", startsAt: "a", endsAt: "b", expectedVersion: 3 });
    assert.deepEqual(result, { ok: true, value: { version: 4, entries: [] } });
  });

  it("maps a version conflict to a message that says the schedule was reloaded", async () => {
    const result = await saveSelection(json(409, { error: "changed" }), { storyId: "story-a", startsAt: "a", endsAt: "b" }, 3);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.match(result.message, /Someone else changed the schedule/);
    }
  });

  it("uses the server's own message for a refused story or bad times, and a plain one for a server that is off", () => {
    assert.equal(apiMessage(422, { error: "Only a published story can be featured." }), "Only a published story can be featured.");
    assert.equal(apiMessage(400, { error: "endsAt must be after startsAt." }), "endsAt must be after startsAt.");
    assert.match(apiMessage(503, {}), /isn't turned on/);
    assert.match(apiMessage(403, {}), /can't change Featured Tonight/);
    assert.match(apiMessage(401, {}), /Sign in as an admin/);
  });

  it("reports a network failure as a connection problem, not as a server answer", async () => {
    const result = await loadSchedule(async () => {
      throw new TypeError("offline");
    });
    assert.deepEqual(result, { ok: false, status: 0, message: "Couldn't reach the server. Check your connection and try again." });
  });

  it("removes a selection by story id with the version in the query", async () => {
    let url = "";
    await removeSelection(async (path) => {
      url = path;
      return json(200, { version: 5, entries: [] })();
    }, "story a/1", 4);
    assert.equal(url, "/api/admin/featured/story%20a%2F1?expectedVersion=4");
  });
});
