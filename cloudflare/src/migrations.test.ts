import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../migrations/", import.meta.url);
const migrations = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
const sql = (name: string) => readFileSync(new URL(name, dir), "utf8");

/** 移行を1ファイル1トランザクションで当てる(D1 はバッチで流す)。 */
function apply(db: DatabaseSync, names: readonly string[]): void {
  for (const name of names) {
    db.exec("BEGIN");
    db.exec(sql(name));
    db.exec("COMMIT");
  }
}

/** 既に練習した履歴。移行はこれを1行も落としてはいけない。 */
function seedHistory(db: DatabaseSync): void {
  db.exec("INSERT INTO users VALUES ('u','u@example.com',1)");
  db.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,ended_at,status,recording_status,model) VALUES ('s1','u','scene','面接',10,20,'ended','available','live')");
  db.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,status,model) VALUES ('s2','u','drill','瞬間英作文',30,'created','live')");
  db.exec("INSERT INTO turns VALUES ('s1','t1',1,'user','I working on it.',11)");
  db.exec("INSERT INTO turns VALUES ('s1','t2',2,'assistant','I am working on it.',12)");
  db.exec("INSERT INTO notes VALUES ('s1','n1',3,'{\"widget\":\"recast\"}',13)");
  db.exec("INSERT INTO results VALUES ('u','e1','s1','interview','recast',14,'{\"kind\":\"recast\"}')");
  db.exec("INSERT INTO result_cards VALUES ('u','e1','card-1')");
  db.exec("INSERT INTO recordings VALUES ('s1','u','audio/u/s1','ready',100,90,'audio/webm',15,999,'abc')");
  db.exec("INSERT INTO review_cards VALUES ('u','card-1',16,0,NULL,'{}')");
}

describe("D1 移行", () => {
  it("0001 だけではボードのセッションを拒む", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      apply(db, ["0001_learning.sql"]);
      db.exec("INSERT INTO users VALUES ('u','u@example.com',1)");
      assert.throws(() => db.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,model) VALUES ('w','u','whiteboard','ボード',1,'live')"),
        /CHECK constraint failed/);
    } finally { db.close(); }
  });

  it("履歴のあるDBでも、作り直しで1行も落とさずボードを許す", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      apply(db, ["0001_learning.sql"]);
      seedHistory(db);
      const before = Object.fromEntries(["sessions", "turns", "notes", "results", "result_cards", "recordings", "review_cards"]
        .map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));

      apply(db, migrations.filter(name => name !== "0001_learning.sql"));

      const after = Object.fromEntries(Object.keys(before)
        .map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n]));
      assert.deepEqual(after, before);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      // 退避用の表を残さない。
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'migrate_%' OR name LIKE '%_new'").all(), []);
      // 中身がそのまま残っている。
      assert.deepEqual(db.prepare("SELECT id,mode,label,ended_at,status,recording_status FROM sessions ORDER BY id").all().map(row => ({ ...row })), [
        { id: "s1", mode: "scene", label: "面接", ended_at: 20, status: "ended", recording_status: "available" },
        { id: "s2", mode: "drill", label: "瞬間英作文", ended_at: null, status: "created", recording_status: "not_saved" },
      ]);
      assert.equal(db.prepare("SELECT text FROM turns WHERE session_id='s1' AND seq=2").get()!.text, "I am working on it.");
      assert.equal(db.prepare("SELECT object_key FROM recordings WHERE session_id='s1'").get()!.object_key, "audio/u/s1");

      // ボードが入り、他のモードの綴り間違いは今までどおり拒む。
      db.exec("UPDATE sessions SET status='ended' WHERE id='s2'");
      db.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,model) VALUES ('w','u','whiteboard','ボード',40,'live')");
      db.exec("INSERT INTO turns VALUES ('w','t9',9,'user','This is my architecture.',41)");
      assert.throws(() => db.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,model) VALUES ('x','u','board','板',50,'live')"),
        /CHECK constraint failed/);
      // 索引も戻っている: 同時に開けるレッスンは1本、存在しないセッションの発言は入らない。
      assert.throws(() => db.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,model) VALUES ('w2','u','whiteboard','ボード',60,'live')"),
        /UNIQUE constraint failed/);
      assert.throws(() => db.exec("INSERT INTO turns VALUES ('nope','t8',8,'user','hi',70)"), /FOREIGN KEY constraint failed/);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sessions_by_user'").get());
    } finally { db.close(); }
  });
});
