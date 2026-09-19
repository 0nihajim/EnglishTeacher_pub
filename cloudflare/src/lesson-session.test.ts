import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LessonSession, readClientMessage } from "./lesson-session";
import { testDatabase } from "./test-database";
import { testState } from "./test-state";

it("終了時にD1が失敗しても、再起動後のalarmで元の終了時刻を確定する", async () => {
  const { db, sqlite } = testDatabase();
  const state = testState();
  try {
    sqlite.exec("INSERT INTO users VALUES ('owner','owner@example.com',1)");
    sqlite.exec("INSERT INTO sessions(id,user_id,mode,label,started_at,model) VALUES ('s','owner','scene','test',1,'test')");
    state.values.set("meta", { id: "s", userId: "owner", closed: false, sequence: 0, startedAt: 1 });
    const faulty = { prepare() { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    const lesson = new LessonSession(state.ctx, { DB: faulty } as Env);
    const response = await lesson.fetch(new Request("https://internal/end", { method: "POST", headers: { "X-User-Id": "owner" } }));
    assert.equal(response.status, 500);
    assert.ok(state.alarm());
    const expected = state.values.get("meta") as { endedAt: number };
    assert.ok(expected.endedAt > 0);
    const resumed = new LessonSession(state.ctx, { DB: db } as Env);
    await resumed.alarm();
    const row = sqlite.prepare("SELECT status,ended_at FROM sessions WHERE id='s'").get()!;
    assert.equal(row.status, "ended");
    assert.equal(row.ended_at, expected.endedAt);
    assert.equal(state.alarm(), null);
  } finally { sqlite.close(); }
});

it("ボードはシーンも画像も要らずに開き、D1にmode=whiteboardで残る", async () => {
  const { db, sqlite } = testDatabase();
  const state = testState();
  try {
    sqlite.exec("INSERT INTO users VALUES ('owner','owner@example.com',1)");
    const lesson = new LessonSession(state.ctx, { DB: db, GEMINI_LIVE_MODEL: "live-test" } as Env);
    const response = await lesson.fetch(new Request("https://internal/initialize", {
      method: "POST",
      body: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", userId: "owner", request: { mode: "whiteboard" } }),
    }));
    assert.equal(response.status, 201);
    const body = await response.json() as { mode: string; turn_taking: string; scene_title?: string };
    assert.equal(body.mode, "whiteboard");
    assert.equal(body.turn_taking, "auto");
    assert.equal(body.scene_title, undefined);
    const row = sqlite.prepare("SELECT mode, label FROM sessions").get()!;
    assert.equal(row.mode, "whiteboard");
    assert.equal(row.label, "ボード");
  } finally { sqlite.close(); }
});

describe("ブラウザから来る1通の上限", () => {
  /** 指定バイト数の JPEG を載せた board_frame。base64 は 3バイトを4文字にする。 */
  const frame = (bytes: number) => JSON.stringify({
    type: "board_frame", mime_type: "image/jpeg", data: "A".repeat(Math.ceil(bytes / 3) * 4), seq: 1,
  });

  it("ボードは100KBの板のフレームを通し、他のモードでは通さない", () => {
    const message = frame(100 * 1024);
    assert.ok(message.length > 32_000, "この検査は 32,000 文字を超える通で意味を持つ");
    assert.equal(readClientMessage(message, "whiteboard")?.type, "board_frame");
    assert.equal(readClientMessage(message, "scene"), null);
  });

  it("1MBを超えるフレーム、壊れたJSON、バイナリは断る", () => {
    assert.equal(readClientMessage(frame(2 * 1024 * 1024), "whiteboard"), null);
    assert.equal(readClientMessage("{", "whiteboard"), null);
    assert.equal(readClientMessage("null", "whiteboard"), null);
    assert.equal(readClientMessage(new ArrayBuffer(8), "whiteboard"), null);
  });

  it("ボードでも板のフレーム以外は 32,000 文字までにする", () => {
    assert.equal(readClientMessage(JSON.stringify({ type: "mic_audio", audio: "A".repeat(40_000) }), "whiteboard"), null);
    assert.equal(readClientMessage(JSON.stringify({ type: "mic_end" }), "whiteboard")?.type, "mic_end");
  });
});
