-- ボード(whiteboard)を sessions.mode に許す。
--
-- SQLite は CHECK 制約を変更できないので、sessions を作り直して中身を移す。ここで
-- 外部キーが邪魔をする: turns / notes / results / recordings が sessions(id) を参照していて、
-- DROP TABLE は消える親の行ぶんだけ違反を作る。D1 では PRAGMA foreign_keys を切れず
-- (すべての問い合わせが暗黙のトランザクションで走る)、PRAGMA defer_foreign_keys でも
-- この違反は解消できない(改名で親が戻っても、遅延カウンタは 0 に戻らない。実SQLiteで確認)。
--
-- そこで、子の行を一度退避して空にし、親を入れ替えてから戻す。親の行が居ない間に子の行も
-- 居ないので、外部キーはどの時点でも満たされている。result_cards は results の子なので、
-- 外す順は子から、戻す順は親からにする。
--
-- D1 は移行ファイルを1つのバッチとして流すので、途中で失敗すればまとめて巻き戻る。

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('scene', 'drill', 'retell', 'review', 'whiteboard')),
  label TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'active', 'ended', 'interrupted', 'failed')),
  recording_status TEXT NOT NULL DEFAULT 'not_saved'
    CHECK (recording_status IN ('not_saved', 'reserved', 'available', 'expired')),
  model TEXT NOT NULL
);
INSERT INTO sessions_new (id, user_id, mode, label, started_at, ended_at, status, recording_status, model)
  SELECT id, user_id, mode, label, started_at, ended_at, status, recording_status, model FROM sessions;

CREATE TABLE migrate_result_cards AS SELECT * FROM result_cards;
CREATE TABLE migrate_recordings AS SELECT * FROM recordings;
CREATE TABLE migrate_results AS SELECT * FROM results;
CREATE TABLE migrate_notes AS SELECT * FROM notes;
CREATE TABLE migrate_turns AS SELECT * FROM turns;
DELETE FROM result_cards;
DELETE FROM recordings;
DELETE FROM results;
DELETE FROM notes;
DELETE FROM turns;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX sessions_by_user ON sessions(user_id, started_at DESC, id DESC);
CREATE UNIQUE INDEX one_active_session_per_user ON sessions(user_id)
  WHERE status IN ('created', 'active');

INSERT INTO turns SELECT * FROM migrate_turns;
INSERT INTO notes SELECT * FROM migrate_notes;
INSERT INTO results SELECT * FROM migrate_results;
INSERT INTO recordings SELECT * FROM migrate_recordings;
INSERT INTO result_cards SELECT * FROM migrate_result_cards;

DROP TABLE migrate_turns;
DROP TABLE migrate_notes;
DROP TABLE migrate_results;
DROP TABLE migrate_recordings;
DROP TABLE migrate_result_cards;
