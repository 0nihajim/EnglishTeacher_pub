import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewSeed, UiMessage } from "../../../shared/messages";
import type { ReviewResultRow } from "../results";
import { ReviewCoach, partialHint } from "./review";

const CARD: ReviewSeed = {
  id: "one", kind: "translation", cue: "昨日働きました。", answer: "I worked yesterday.",
  note: "過去形の worked を使う。", source: "仕事",
  teaching: { alternative: { phrase: "I was at work yesterday.", usage: "職場にいたことに注目" } },
};

function setup(cards = [CARD]) {
  const ui: UiMessage[] = [], nudges: string[] = [], rows: ReviewResultRow[] = [];
  let speaking = false;
  const coach = new ReviewCoach({
    showUi: (message) => ui.push(message), nudge: (text) => nudges.push(text),
    teacherSpeaking: () => speaking, log: () => {},
  }, cards, { onOutcome: (row) => rows.push(row), clock: () => 100_000 });
  const step = () => {
    const message = ui.at(-1);
    assert.ok(message?.widget === "review_step");
    return message.props;
  };
  const begin = () => { coach.onReady(); coach.teacherTurnDone(); };
  const judge = (verdict: string, other: Record<string, unknown> = {}) => {
    coach.learnerSpeechStart();
    coach.learnerSaid("I work yesterday.");
    coach.learnerSpeechEnd();
    return coach.onToolCall("review_result", { attempt_id: coach.attemptId, verdict, ...other });
  };
  return { coach, ui, nudges, rows, step, begin, judge, speaking: (v: boolean) => { speaking = v; } };
}

describe("ReviewCoach", () => {
  it("初回の成功を自力として一度だけ記録し、次へで終了する", () => {
    const s = setup();
    s.begin();
    assert.equal(s.step().answer, undefined);
    const token = s.coach.attemptId;
    s.judge("correct", { said: "I worked yesterday." });
    assert.equal(s.step().outcome, "independent");
    assert.equal(s.rows.length, 1);
    s.coach.onToolCall("review_result", { attempt_id: token, verdict: "correct" });
    s.coach.onControl("skip");
    assert.equal(s.rows.length, 1);
    s.coach.onControl("next");
    assert.equal(s.coach.state, "finished");
    assert.equal(s.ui.at(-1)?.widget, "summary");
  });

  it("間違い→問い→部分ヒント→お手本→隠して再挑戦。答えは公開段階にだけ送る", () => {
    const s = setup();
    s.begin();
    s.judge("wrong", { question: "昨日のことですか？動詞をどう変えますか？", note: "worked にする" });
    assert.equal(s.step().phase, "repair");
    assert.match(s.step().hint!, /昨日/);
    assert.equal(s.step().answer, undefined);
    assert.equal(s.step().note, undefined);
    assert.equal(s.step().teaching, undefined);
    s.judge("close");
    assert.equal(s.step().phase, "hint");
    assert.equal(s.step().hint, "I worked …");
    assert.equal(s.step().answer, undefined);
    s.judge("wrong");
    assert.equal(s.step().phase, "model");
    assert.equal(s.step().answer, CARD.answer);
    s.coach.onControl("retry");
    assert.equal(s.step().phase, "retry");
    assert.equal(s.step().answer, undefined);
    assert.equal(s.step().note, undefined);
    assert.equal(s.step().teaching, undefined);
    s.judge("correct");
    assert.equal(s.rows[0]?.outcome, "modeled");
    assert.equal(s.rows[0]?.attempts, 4);
  });

  it("自己修正とヒント後の成功を独立した結果として残す", () => {
    const repair = setup();
    repair.begin(); repair.judge("wrong"); repair.judge("correct");
    assert.equal(repair.rows[0]?.outcome, "repaired");
    const hint = setup();
    hint.begin(); hint.coach.onControl("hint"); hint.judge("correct");
    assert.equal(hint.rows[0]?.outcome, "hinted");
  });

  it("判定前・送信前・古い課題のツール報告を断る", () => {
    const s = setup([CARD, { ...CARD, id: "two", answer: "I rested yesterday." }]);
    s.coach.onReady();
    assert.equal(s.coach.onToolCall("review_result", { attempt_id: "", verdict: "correct" }).response.recorded, false);
    s.coach.teacherTurnDone();
    const token = s.coach.attemptId;
    assert.equal(s.coach.onToolCall("review_result", { attempt_id: token, verdict: "correct" }).response.recorded, false);
    s.judge("correct");
    s.coach.onControl("next");
    s.coach.learnerSpeechEnd();
    assert.equal(s.coach.onToolCall("review_result", { attempt_id: token, verdict: "correct" }).response.recorded, false);
    assert.equal(s.rows.length, 1);
    assert.equal(s.step().index, 2);
  });

  it("不明瞭な音声は未評価のまま再提出し、失敗や支援ありにしない", () => {
    const s = setup(); s.begin();
    const token = s.coach.attemptId;
    s.judge("uncertain");
    assert.equal(s.rows.length, 0);
    assert.notEqual(s.coach.attemptId, token);
    assert.match(s.step().hint!, /聞き取り/);
    s.judge("correct");
    assert.equal(s.rows[0]?.outcome, "independent");
    assert.equal(s.rows[0]?.attempts, 1);
  });

  it("自力修正の問いに英語の答えが混じったら、答えのない問いに差し替える", () => {
    const s = setup(); s.begin();
    s.judge("wrong", { question: '「I worked yesterday.」と言ってみよう。' });
    assert.ok(!s.step().hint?.includes("worked"));
  });

  it("お手本の確認は時間で進まず、再挑戦ボタンを待つ。失敗が続けば後日の復習へ", () => {
    const s = setup(); s.begin();
    s.coach.onControl("reveal");
    s.coach.teacherTurnDone();
    assert.equal(s.coach.state, "model");
    s.coach.onControl("retry"); s.judge("wrong");
    assert.equal(s.coach.state, "model");
    s.coach.onControl("retry"); s.judge("wrong");
    assert.equal(s.rows[0]?.outcome, "again");
    assert.equal(s.rows.length, 1);
  });

  it("先生の生成中は新しい指示を保留し、終了の一言もターンの後に送る", () => {
    const s = setup(); s.begin();
    const before = s.nudges.length;
    s.speaking(true); s.judge("correct");
    assert.equal(s.nudges.length, before);
    s.coach.onControl("next");
    s.speaking(false); s.coach.teacherTurnDone();
    assert.match(s.nudges.at(-1)!, /おつかれさま/);
    s.coach.teacherTurnDone();
    assert.equal(s.nudges.length, before + 1);
  });

  it("中断を失敗として記録せず、スキップは明示操作のときだけ記録する", () => {
    const s = setup(); s.begin(); s.coach.dispose();
    s.coach.onControl("skip");
    assert.equal(s.rows.length, 0);
    const t = setup(); t.begin(); t.coach.onControl("skip");
    assert.equal(t.rows[0]?.outcome, "skipped");
    assert.equal(t.rows[0]?.attempts, 0);
  });

  it("送信後の判定漏れのみ催促し、思考中は急かさない", () => {
    const s = setup(); s.begin();
    assert.equal(s.coach.silenceNudge(), null);
    s.coach.learnerSpeechEnd();
    assert.match(s.coach.silenceNudge()!, /review_result/);
  });

  it("復旧後も確定済みの課題を二重採点せず、同じ履歴IDで次の課題へ進む", () => {
    const cards = [CARD, { ...CARD, id: "two", answer: "I rested yesterday." }];
    const first = setup(cards); first.begin(); first.judge("correct");
    const snapshot = first.coach.checkpoint();
    const resumed = setup(cards);
    assert.equal(resumed.coach.restore(snapshot), true);
    resumed.coach.onReady();
    resumed.judge("correct");
    assert.equal(resumed.rows.length, 0);
    resumed.coach.onControl("next");
    resumed.judge("correct");
    first.coach.onControl("next"); first.judge("correct");
    assert.equal(resumed.rows[0]?.eventId, first.rows[1]?.eventId);
    first.coach.dispose(); resumed.coach.dispose();
  });

  it("中断した送信は復旧直後に採点せず、再提出を待つ", () => {
    const first = setup(); first.begin(); first.coach.learnerSpeechEnd();
    const resumed = setup();
    resumed.coach.restore(first.coach.checkpoint());
    const reply = resumed.coach.onToolCall("review_result", { attempt_id: resumed.coach.attemptId, verdict: "correct" });
    assert.equal(reply.response.recorded, false);
    assert.equal(resumed.rows.length, 0);
    first.coach.dispose(); resumed.coach.dispose();
  });
});

describe("partialHint", () => {
  it("短い答えも全体を出さない", () => {
    for (const answer of ["a", "Yes", "Thank you", "I worked yesterday.", "make progress on + noun"]) {
      assert.ok(!partialHint(answer).includes(answer));
    }
  });
});
