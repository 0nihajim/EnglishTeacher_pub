import assert from "node:assert/strict";
import { it } from "node:test";
import worker from "./index";
import { testDatabase } from "./test-database";
import { testState } from "./test-state";
import { UserProgress } from "./user-progress";

function fixture() {
  const data = testDatabase();
  const env = { DB: data.db, LOCAL_DEV: "true", OWNER_EMAIL: "owner@example.com" } as Env;
  const progress = new UserProgress(testState().ctx, env);
  env.PROGRESS = {
    idFromName: () => "owner",
    get: () => ({ fetch: (input: string, init: RequestInit) => progress.fetch(new Request(input, init)) }),
  } as unknown as Env["PROGRESS"];
  const call = (path: string, body?: object) => worker.fetch(new Request(`http://localhost${path}`, {
    ...(body ? { method: "POST", headers: { Origin: "http://localhost" }, body: JSON.stringify(body) } : {}),
  }), env);
  return { ...data, env, call };
}

it("同じ開始時刻の履歴が31件以上あっても、次のページで抜け・重複がない", async () => {
  const s = fixture();
  try {
    await s.call("/api/scenes");
    for (let i = 0; i < 35; i++) s.sqlite.prepare(`INSERT INTO sessions(id,user_id,mode,label,started_at,status,model)
      VALUES (?,'local-owner','scene','test',1,'ended','test')`).run(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    const first = await (await s.call("/api/history")).json() as { sessions: { id: string }[]; next: string };
    const second = await (await s.call(`/api/history?before=${encodeURIComponent(first.next)}`)).json() as { sessions: { id: string }[]; next: string | null };
    assert.equal(first.sessions.length, 30);
    assert.equal(second.sessions.length, 5);
    assert.equal(new Set([...first.sessions, ...second.sessions].map(row => row.id)).size, 35);
    assert.equal(second.next, null);
  } finally { s.sqlite.close(); }
});

it("期限が過ぎた録音は物理削除待ちでも再生させず、R2を読まない", async () => {
  const s = fixture();
  try {
    await s.call("/api/scenes");
    const id = "00000000-0000-0000-0000-000000000001";
    s.sqlite.prepare(`INSERT INTO sessions(id,user_id,mode,label,started_at,status,model)
      VALUES (?,'local-owner','scene','test',1,'ended','test')`).run(id);
    s.sqlite.prepare(`INSERT INTO recordings(session_id,user_id,object_key,status,reserved_bytes,reserved_until,expires_at)
      VALUES (?,'local-owner','key','ready',0,0,0)`).run(id);
    let reads = 0;
    s.env.RECORDINGS = { get: async () => { reads++; throw new Error("should not read"); } } as unknown as R2Bucket;
    assert.equal((await s.call(`/api/recordings/${id}`)).status, 404);
    assert.equal(reads, 0);
    assert.equal((await s.call(`/api/history/${id}`)).status, 200);
  } finally { s.sqlite.close(); }
});

it("ローカル履歴の取り込みを再送しても同じ課題を二重に増やさない", async () => {
  const s = fixture();
  try {
    const body = { eventId: "local:test", sceneId: "test", row: {
      kind: "drill", at: "2026-09-18T01:00:00Z", scene: "test", round: 1,
      ja: "少し待って", en: "Give me a moment.", verdict: "wrong",
    } };
    assert.equal((await s.call("/api/import/results", body)).status, 200);
    assert.equal((await s.call("/api/import/results", body)).status, 200);
    assert.equal(s.sqlite.prepare("SELECT COUNT(*) AS n FROM results").get()!.n, 1);
    assert.equal(s.sqlite.prepare("SELECT COUNT(*) AS n FROM review_cards").get()!.n, 1);
    assert.equal((await s.call("/api/import/results", { ...body, eventId: "bad", row: {} })).status, 400);
  } finally { s.sqlite.close(); }
});
