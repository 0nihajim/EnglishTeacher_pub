import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerMessage, UiMessage } from "../../shared/messages";
import { ReviewCoach } from "./modes/review";
import type { Coach, SessionPlan } from "./modes/types";
import { Session, type SessionBridge } from "./session";

function bridge(): SessionBridge {
  return {
    generating: false, activityOpen: false,
    start: async () => {}, close: async () => {},
    sendMicAudio: () => {}, endMicStream: () => {},
    startActivity: () => {}, endActivity: () => {}, nudge: () => {}, sendVideoFrame: () => {},
  };
}

describe("Session teacher turn boundaries", () => {
  it("終了時に自分とモデルの未確定字幕も保存先へ一度だけ渡す", async () => {
    const messages: ServerMessage[] = [];
    const plan: SessionPlan = {
      mode: "review", label: "test", systemInstruction: "", greeting: "", tools: [],
      coach: () => ({
        onToolCall: () => ({ response: {}, scheduling: "SILENT" }),
        teacherSaid() {}, learnerSaid() {}, teacherTurnDone() {}, dispose() {},
      }),
    };
    const session = new Session("test", plan, "manual", () => {}, bridge, { onMessage: message => messages.push(message) });
    session.onFragment("user", "My last words.");
    session.onFragment("assistant", "The final feedback.");
    await session.stop(); await session.stop();
    assert.deepEqual(messages.filter(message => message.type === "turn" && message.done).map(message =>
      message.type === "turn" ? [message.role, message.text] : null), [
      ["user", "My last words."], ["assistant", "The final feedback."],
    ]);
  });
  it("字幕・音声のないツール応答でも進行し、二重の終了通知では進めない", async () => {
    let completed = 0;
    const coach: Coach = {
      onToolCall: () => ({ response: {}, scheduling: "SILENT" }),
      teacherSaid: () => {}, learnerSaid: () => {}, teacherTurnDone: () => { completed++; }, dispose: () => {},
    };
    const plan: SessionPlan = { mode: "review", label: "test", systemInstruction: "", greeting: "", tools: [], coach: () => coach };
    const session = new Session("test", plan, "manual", () => {}, bridge);
    session.onToolCall("review_result", {});
    session.onTurnComplete();
    assert.equal(completed, 1);
    session.onTurnComplete();
    assert.equal(completed, 1);
    session.onAudio(Buffer.alloc(320).toString("base64"));
    session.onInterrupted();
    session.onTurnComplete();
    assert.equal(completed, 2);
    session.onFragment("assistant", "Hello");
    session.onTurnComplete();
    assert.equal(completed, 3);
    await session.stop();
    assert.equal(session.onToolCall("review_result", {}).response.recorded, false);
    session.onTurnComplete();
    assert.equal(completed, 3);
  });

  it("音声なしの判定から自己修正の問いを送り、手動の再提出を受け付ける", async () => {
    const ui: UiMessage[] = [], nudges: string[] = [];
    const fakeBridge = bridge();
    fakeBridge.nudge = (text) => { nudges.push(text); };
    let coach!: ReviewCoach;
    const plan: SessionPlan = {
      mode: "review", label: "test", systemInstruction: "", greeting: "", tools: [],
      coach: (host) => {
        coach = new ReviewCoach({ ...host, showUi: (message) => ui.push(message) }, [{
          id: "one", kind: "translation", cue: "昨日働きました", answer: "I worked yesterday.", source: "test",
        }]);
        return coach;
      },
    };
    const session = new Session("test", plan, "manual", () => {}, () => fakeBridge);
    session.onReady();
    session.onFragment("assistant", "復習しましょう");
    session.onTurnComplete();
    session.startSpeech();
    session.onFragment("user", "I work yesterday.", true);
    session.endSpeech();
    const before = nudges.length;
    Object.defineProperty(fakeBridge, "generating", { configurable: true, value: true });
    session.onToolCall("review_result", { attempt_id: coach.attemptId, verdict: "wrong", question: "昨日のことですか？" });
    assert.equal(nudges.length, before);
    Object.defineProperty(fakeBridge, "generating", { configurable: true, value: false });
    session.onTurnComplete(); // 先生の字幕はない。
    assert.match(nudges.at(-1)!, /昨日のことですか/);
    assert.equal(coach.state, "repair");
    session.startSpeech(); session.endSpeech();
    session.onToolCall("review_result", { attempt_id: coach.attemptId, verdict: "correct", said: "I worked yesterday." });
    assert.equal(coach.state, "done");
    await session.stop();
  });
});

describe("Session board frames", () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString("base64");

  function whiteboardSession(sent: number[], changed: number[]) {
    const fakeBridge = bridge();
    fakeBridge.sendVideoFrame = (frame) => { sent.push(frame.bytes); };
    const plan: SessionPlan = {
      mode: "whiteboard", label: "test", systemInstruction: "", greeting: "", tools: [],
      coach: () => ({
        onToolCall: () => ({ response: {}, scheduling: "SILENT" }),
        teacherSaid() {}, learnerSaid() {}, teacherTurnDone() {}, dispose() {},
        boardChanged: (seq) => { changed.push(seq); },
      }),
    };
    return new Session("test", plan, "auto", () => {}, () => fakeBridge);
  }

  it("検査を通ったフレームだけを上流に渡し、コーチに連番を知らせる", async () => {
    const sent: number[] = [], changed: number[] = [];
    const session = whiteboardSession(sent, changed);
    session.boardFrame({ type: "board_frame", mime_type: "image/jpeg", data: JPEG, seq: 1 }, 1, 0);
    session.boardFrame({ type: "board_frame", mime_type: "image/jpeg", data: "not base64!!", seq: 2 }, 2, 1_000);
    session.boardFrame({ type: "board_frame", mime_type: "image/jpeg", data: JPEG, seq: 3 }, 3, 2_000);
    assert.deepEqual(sent, [68, 68]);
    assert.deepEqual(changed, [1, 3]);
    await session.stop();
  });

  it("1秒以内に続けて来たフレームは最後の1枚を待たせ、間隔が明けるまで送らない", async () => {
    const sent: number[] = [], changed: number[] = [];
    const session = whiteboardSession(sent, changed);
    session.boardFrame({ data: JPEG }, 1, 0);
    session.boardFrame({ data: JPEG }, 2, 200);
    session.boardFrame({ data: JPEG }, 3, 400);
    assert.deepEqual(changed, [1]);
    // 終了で待ちは捨てる(タイマーが後から鳴らない)。
    await session.stop();
    assert.deepEqual(changed, [1]);
  });

  it("描くこと自体を生存の合図に数える", async () => {
    const session = whiteboardSession([], []);
    const before = session.lastActivityAt;
    session.boardFrame({ data: JPEG }, 1, before + 60_000);
    assert.equal(session.lastActivityAt, before + 60_000);
    await session.stop();
  });
});
