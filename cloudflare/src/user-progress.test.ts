import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserProgress } from "./user-progress";
import { MAX_RECORDING_BYTES } from "./recording-policy";
import { testDatabase } from "./test-database";
import { testState } from "./test-state";

function setup() {
  const { db, sqlite } = testDatabase();
  sqlite.prepare("INSERT INTO users VALUES ('owner','owner@example.com',?)").run(Date.now());
  for (const id of ["one", "two"]) sqlite.prepare(`INSERT INTO sessions (id,user_id,mode,label,started_at,model,status)
    VALUES (?,'owner','scene','Test',?,'test','ended')`).run(id, Date.now());
  let deletionFails = false;
  const deleted: string[] = [];
  const env = {
    DB: db, RECORDING_ENABLED: "true", MAX_SESSION_SECONDS: "3600",
    RECORDING_BUDGET_BYTES: String(MAX_RECORDING_BYTES * 2),
    RECORDINGS: { async delete(key: string) { if (deletionFails) throw new Error("storage unavailable"); deleted.push(key); } },
  } as unknown as Env;
  const progress = new UserProgress(testState().ctx, env);
  const call = (path: string, body: object = {}) => progress.fetch(new Request(`https://internal${path}`, {
    method: "POST", body: JSON.stringify({ userId: "owner", sessionId: "one", ...body }),
  }));
  return { sqlite, call, deleted, failDeletion: (value: boolean) => { deletionFails = value; } };
}

describe("recording capacity and cleanup", () => {
  it("同時の予約で予算を超えず、同じ予約の再送は容量を二重に使わない", async () => {
    const s = setup();
    try {
      const replies = await Promise.all([s.call("/reserve"), s.call("/reserve", { sessionId: "two" })]);
      const values = await Promise.all(replies.map(response => response.json() as Promise<{ enabled: boolean }>));
      assert.deepEqual(values.map(value => value.enabled).sort(), [false, true]);
      await s.call("/reserve");
      assert.equal(s.sqlite.prepare("SELECT reserved_bytes FROM recording_budget").get()!.reserved_bytes, MAX_RECORDING_BYTES);
    } finally { s.sqlite.close(); }
  });
  it("削除失敗中は使用量を維持し、再試行の成功後だけ解放する。ノートは残る", async () => {
    const s = setup();
    try {
      await s.call("/reserve");
      assert.equal((await s.call("/begin-upload", { bytes: 1000 })).status, 200);
      assert.equal((await s.call("/finish-upload", { bytes: 1000, contentType: "audio/webm", sha256: "hash" })).status, 200);
      await s.call("/finish-upload", { bytes: 1000, contentType: "audio/webm", sha256: "hash" });
      assert.equal(s.sqlite.prepare("SELECT used_bytes FROM recording_budget").get()!.used_bytes, 1000);
      await s.call("/delete-recording");
      assert.equal(s.deleted.length, 0); // 期限前は消さない。
      s.sqlite.exec("UPDATE recordings SET expires_at = 0");
      s.sqlite.exec(`INSERT INTO notes VALUES ('one','note',1,'{}',1)`);
      s.failDeletion(true);
      assert.equal((await s.call("/delete-recording")).status, 500);
      assert.equal(s.sqlite.prepare("SELECT used_bytes FROM recording_budget").get()!.used_bytes, 1000);
      s.failDeletion(false);
      await s.call("/delete-recording");
      await s.call("/delete-recording");
      assert.equal(s.deleted.length, 1);
      assert.equal(s.sqlite.prepare("SELECT used_bytes FROM recording_budget").get()!.used_bytes, 0);
      assert.equal(s.sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get()!.n, 1);
    } finally { s.sqlite.close(); }
  });
});
