import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testDatabase } from "./test-database";
import { appendResult, dailyReview, ensureUser, ownedSession, readResults, saveNote, saveTurn } from "./store";
import { buildReviewCards } from "../../server/src/review";
import type { DrillResultRow, ReviewResultRow } from "../../server/src/results";

const at = Date.parse("2026-09-18T01:00:00Z");
const drill: DrillResultRow = { kind: "drill", at: new Date(at).toISOString(), scene: "test", round: 1, ja: "少し待って", en: "Give me a moment.", verdict: "wrong" };

describe("D1 learning records", () => {
  it("ユーザーを分離し、再配送で復習段階を二重に進めない", async () => {
    const { db, sqlite } = testDatabase();
    try {
      await ensureUser(db, { id: "a", email: "a@example.com" });
      await ensureUser(db, { id: "b", email: "b@example.com" });
      await appendResult(db, "a", null, "test", "drill-1", drill);
      const card = buildReviewCards([drill])[0]!;
      const review: ReviewResultRow = { kind: "review", eventId: "review-1", card, outcome: "independent", attempts: 1, at: new Date(at + 1000).toISOString() };
      await appendResult(db, "a", null, "_reviews", review.eventId, review);
      await appendResult(db, "a", null, "_reviews", review.eventId, review);
      const stored = sqlite.prepare("SELECT payload FROM review_cards WHERE user_id = 'a'").get()!;
      assert.equal(JSON.parse(stored.payload as string).level, 1);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM results").get()!.n, 2);
      assert.equal((await dailyReview(db, "b", at)).plan.total, 0);
      assert.equal((await readResults(db, "b", "test")).length, 0);
      await assert.rejects(appendResult(db, "a", null, "_reviews", review.eventId, { ...review, outcome: "again" }));
    } finally { sqlite.close(); }
  });
  it("遅れて届いた履歴も日時順に反映する", async () => {
    const { db, sqlite } = testDatabase();
    try {
      await ensureUser(db, { id: "a", email: "a@example.com" });
      const card = buildReviewCards([drill])[0]!;
      const review: ReviewResultRow = { kind: "review", eventId: "review-2", card, outcome: "independent", attempts: 1, at: new Date(at + 1000).toISOString() };
      await appendResult(db, "a", null, "_reviews", review.eventId, review);
      await appendResult(db, "a", null, "test", "late-drill", drill);
      const actual = JSON.parse(sqlite.prepare("SELECT payload FROM review_cards").get()!.payload as string);
      assert.deepEqual(actual, JSON.parse(JSON.stringify(buildReviewCards([review, drill])[0])));
      const plan = (await dailyReview(db, "a", at + 2000)).plan;
      assert.equal(plan.practicedToday, 1);
      assert.equal(plan.due, 0);
      assert.equal(JSON.stringify(plan).includes(drill.en), false);
    } finally { sqlite.close(); }
  });
  it("録音を削除してもスクリプトとノートが残る", async () => {
    const { db, sqlite } = testDatabase();
    try {
      await ensureUser(db, { id: "a", email: "a@example.com" });
      sqlite.prepare("INSERT INTO sessions(id, user_id, mode, label, started_at, model) VALUES ('s', 'a', 'scene', 'Lesson', ?, 'test')").run(at);
      await saveTurn(db, "s", { id: "user_1", role: "user", text: "I go yesterday.", done: true }, 1, at);
      await saveTurn(db, "s", { id: "assistant_2", role: "assistant", text: "I went yesterday.", done: true }, 2, at);
      await saveNote(db, "s", { widget: "recast", props: { original: "I go yesterday.", better: "I went yesterday." } }, 3, at);
      sqlite.prepare(`INSERT INTO recordings(session_id,user_id,object_key,status,reserved_bytes,reserved_until,expires_at)
        VALUES('s','a','key','ready',0,?,?)`).run(at, at);
      sqlite.exec("DELETE FROM recordings WHERE session_id = 's'");
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM turns").get()!.n, 2);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get()!.n, 1);
      await assert.rejects(ownedSession(db, "b", "s"));
    } finally { sqlite.close(); }
  });
});
