import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { UiMessage } from "../../../shared/messages";
import type { Analyst, RetellAnalysis, RetellInput, TellingAnalysis, TellingInput } from "../flash";
import type { NudgeMode } from "../gemini";
import type { LearnerImage } from "../image";
import {
  RETELL_ANSWER_NUDGE,
  RETELL_FALLBACK_REVIEW_NUDGE,
  RETELL_FILLER_NUDGE,
  RETELL_HINT_NUDGE,
  retellPromptLines,
} from "../prompts";
import type { RetellResultRow } from "../results";
import type { Take } from "../takes";
import { RetellCoach, countWords, usedInRetell } from "./retell";
import type { CoachHost } from "./types";

type Widget = UiMessage["widget"];
type Of<W extends Widget> = Extract<UiMessage, { widget: W }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const IMAGE: LearnerImage = { mimeType: "image/jpeg", data: "/9j/", bytes: 3 };

const ANALYSIS: TellingAnalysis = {
  transcript: "This is my app. I make login page. It was difficult because API.",
  points: ["アプリの画面", "ログイン画面を作った", "API で苦労"],
  improvements: [
    { original: "I make login page", better: "I built the login page", note: "過去のことなので built" },
    { original: "It was difficult because API", better: "It was hard because of the API", note: "because of + 名詞" },
  ],
  keywords: ["my app", "login page", "built", "API", "next"],
  question: "What will you work on next?",
  assessment: [{ criterion: "grammar", score: 2, evidence: "I make login page", reason: "過去形と冠詞" }],
  teaching: {
    alternative: { phrase: "I created the login page.", usage: "作成したものを端的に伝える" },
    collocation: { phrase: "run into a problem", meaning: "問題にぶつかる", example: "I ran into a problem with the API." },
    practice: "直面した問題を一文で話す",
  },
};

const RETELL: RetellAnalysis = {
  transcript: "This is my app. I built the login page. It was hard because the API changed.",
  points: ["アプリの画面", "ログイン画面を作った"],
  used: ["I built the login page"],
  comment: "時制が安定した。because of も次は使おう",
  assessment: [{ criterion: "grammar", score: 4, evidence: "I built the login page", reason: "過去形と冠詞が改善" }],
};

/** ms ぶんの録音(中身はゼロ)。endedAt を渡すと、その時刻に送信したことになる。 */
function take(ms: number, endedAt = 0): Take {
  return { pcm: Buffer.alloc(ms * 32), durationMs: ms, startedAt: endedAt - ms, endedAt, truncated: false };
}

function setup() {
  const ui: UiMessage[] = [];
  const nudges: { text: string; mode: NudgeMode }[] = [];
  const rows: RetellResultRow[] = [];
  let speaking = false;
  let now = 100_000;
  const telling = deferred<TellingAnalysis>();
  const retell = deferred<RetellAnalysis>();
  const calls = { telling: [] as TellingInput[], retell: [] as RetellInput[] };
  const analyst: Analyst = {
    analyzeTelling: (input) => {
      calls.telling.push(input);
      return telling.promise;
    },
    analyzeRetell: (input) => {
      calls.retell.push(input);
      return retell.promise;
    },
  };
  const host: CoachHost = {
    showUi: (u) => ui.push(u),
    nudge: (text, mode) => nudges.push({ text, mode }),
    log: () => {},
    teacherSpeaking: () => speaking,
  };
  const coach = new RetellCoach(host, IMAGE, {
    analyst,
    clock: () => now,
    minTakeMs: 1_500,
    fillerMs: 7_000,
    reviewFloorMs: 2_500,
    onOutcome: (row) => rows.push(row),
  });
  const last = <W extends Widget>(widget: W): Of<W> | undefined =>
    ui.filter((u): u is Of<W> => u.widget === widget).at(-1);
  /** Promise の then を走らせる。 */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    ui,
    nudges,
    rows,
    coach,
    last,
    calls,
    telling,
    retell,
    flush,
    setSpeaking: (v: boolean) => {
      speaking = v;
    },
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

/** 挨拶 → 1回目を送る → (時間を進める)。analyzing で止まる。 */
function tell(s: ReturnType<typeof setup>, ms = 45_000) {
  s.coach.onReady();
  s.coach.teacherTurnDone(); // 挨拶が終わった
  s.coach.learnerSpeechStart();
  s.coach.learnerSaid("this is my app", true);
  s.coach.learnerSaid("i make login page", true);
  s.tick(ms);
  s.coach.learnerSpeechEnd(take(ms, s.now()));
  s.tick(3_000); // 先生の一言のぶん
}

describe("RetellCoach", () => {
  it("復旧用の状態にPCMを保存せず、分析中の中断は話す段階からやり直す", () => {
    const first = setup();
    first.coach.onReady(); first.coach.teacherTurnDone();
    first.coach.learnerSpeechStart();
    first.coach.learnerSpeechEnd(take(5_000));
    assert.equal(first.coach.state, "analyzing");
    const checkpoint = first.coach.checkpoint();
    assert.equal(JSON.stringify(checkpoint).includes('"pcm"'), false);
    const resumed = setup();
    assert.equal(resumed.coach.restore(checkpoint), true);
    assert.equal(resumed.coach.state, "telling");
    assert.equal(resumed.calls.telling.length, 0);
    first.coach.dispose(); resumed.coach.dispose();
  });
  it("開始時に観点の板を出し、挨拶が終わると1回目へ", () => {
    const { coach, last } = setup();
    coach.onReady();
    const board = last("retell_board");
    assert.equal(board?.props.phase, "greeting");
    assert.deepEqual(board?.props.lines, retellPromptLines());
    assert.equal(coach.state, "greeting");
    coach.teacherTurnDone();
    assert.equal(coach.state, "telling");
    assert.equal(last("retell_board")?.props.phase, "telling");
    coach.dispose();
  });

  it("1回目を送ると整理を頼み、先生の一言の後に講評(カードと now の nudge)。講評が終わると2回目(キーワードの板、next-turn)", async () => {
    const s = setup();
    const { coach, nudges, last, calls, telling, flush } = s;
    tell(s);
    assert.equal(coach.state, "analyzing");
    assert.equal(last("retell_board")?.props.phase, "analyzing");
    assert.equal(calls.telling.length, 1);
    assert.equal(calls.telling[0]?.transcriptHint, "this is my app i make login page");
    assert.deepEqual(calls.telling[0]?.prompts, retellPromptLines());
    assert.equal(calls.telling[0]?.take.durationMs, 45_000);

    coach.teacherTurnDone(); // 「聞きました」の一言が終わった。整理はまだ
    assert.equal(coach.state, "analyzing");
    telling.resolve(ANALYSIS);
    await flush();
    assert.equal(coach.state, "reviewing");
    const review = last("retell_review");
    assert.deepEqual(review?.props.improvements, ANALYSIS.improvements);
    assert.deepEqual(review?.props.points, ANALYSIS.points);
    assert.deepEqual(review?.props.assessment, ANALYSIS.assessment);
    assert.deepEqual(review?.props.teaching, ANALYSIS.teaching);
    const n = nudges.at(-1);
    assert.equal(n?.mode, "now");
    assert.ok(n?.text.includes('"I built the login page"'));
    assert.ok(n?.text.includes("改善点2"));

    coach.teacherTurnDone(); // 講評が終わった
    assert.equal(coach.state, "retelling");
    assert.ok(s.ui.some((u) => u.widget === "hide")); // お手本のカードは下げる
    const board = last("retell_board");
    assert.equal(board?.props.phase, "retelling");
    assert.deepEqual(board?.props.lines, ANALYSIS.keywords);
    assert.equal(nudges.at(-1)?.mode, "next-turn");
    assert.ok(nudges.at(-1)?.text.includes(ANALYSIS.question));
    coach.dispose();
  });

  it("整理が先に返っても、先生が喋っている間は講評を始めない", async () => {
    const s = setup();
    const { coach, telling, flush, setSpeaking } = s;
    tell(s);
    setSpeaking(true);
    telling.resolve(ANALYSIS);
    await flush();
    assert.equal(coach.state, "analyzing");
    setSpeaking(false);
    coach.teacherTurnDone();
    assert.equal(coach.state, "reviewing");
    coach.dispose();
  });

  it("送信の直後に整理が返ったら、先生の一言が始まる前の下限まで待つ", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup();
    const { coach, telling, flush, tick } = s;
    coach.onReady();
    coach.teacherTurnDone();
    coach.learnerSpeechStart();
    coach.learnerSpeechEnd(take(30_000, s.now())); // いま送信
    telling.resolve(ANALYSIS);
    await flush();
    assert.equal(coach.state, "analyzing"); // 送信から 0ms。まだ差し込まない
    tick(2_500);
    mock.timers.tick(2_500);
    assert.equal(coach.state, "reviewing");
    coach.dispose();
    mock.timers.reset();
  });

  it("短すぎる送信と録音の無い送信は、段階を進めない", () => {
    const { coach, calls } = setup();
    coach.onReady();
    coach.teacherTurnDone();
    coach.learnerSpeechStart();
    coach.learnerSpeechEnd(take(800));
    assert.equal(coach.state, "telling");
    coach.learnerSpeechEnd(null);
    assert.equal(coach.state, "telling");
    assert.equal(calls.telling.length, 0);
    coach.dispose();
  });

  it("ヒントは学習者の番だけ出し、回数はその回に付く", async () => {
    const s = setup();
    const { coach, nudges, telling, retell, flush, rows, tick } = s;
    coach.onReady();
    coach.teacherTurnDone();
    coach.onControl("hint");
    assert.deepEqual(nudges.at(-1), { text: RETELL_HINT_NUDGE, mode: "now" });
    coach.onControl("hint");
    coach.learnerSpeechStart();
    coach.learnerSpeechEnd(take(30_000, s.now()));
    tick(3_000);
    const before = nudges.length;
    coach.onControl("hint"); // 整理待ちでは出さない
    assert.equal(nudges.length, before);
    telling.resolve(ANALYSIS);
    await flush();
    coach.teacherTurnDone(); // 講評 → 2回目
    coach.onControl("hint");
    assert.equal(nudges.at(-1)?.text, RETELL_HINT_NUDGE);
    coach.learnerSpeechStart();
    coach.learnerSpeechEnd(take(30_000, s.now()));
    coach.teacherTurnDone(); // 質問 → 答え
    coach.learnerSpeechStart();
    coach.learnerSpeechEnd(take(5_000, s.now()));
    coach.teacherTurnDone(); // 締め → 終わり
    retell.resolve(RETELL);
    await flush();
    assert.equal(rows[0]?.first?.hints, 2);
    assert.equal(rows[0]?.second?.hints, 1);
    coach.dispose();
  });

  it("整理に失敗したら先生に任せ、2回目の板は観点のまま", async () => {
    const s = setup();
    const { coach, nudges, last, telling, flush } = s;
    tell(s);
    telling.reject(new Error("boom"));
    await flush();
    assert.equal(coach.state, "reviewing");
    assert.equal(nudges.at(-1)?.text, RETELL_FALLBACK_REVIEW_NUDGE);
    assert.equal(last("retell_review"), undefined);
    coach.teacherTurnDone();
    const board = last("retell_board");
    assert.equal(board?.props.phase, "retelling");
    assert.deepEqual(board?.props.lines, retellPromptLines());
    assert.ok(board?.props.note);
    coach.dispose();
  });

  it("2回目 → 講評と質問 → 答え → 締め → 比較と記録", async () => {
    const s = setup();
    const { coach, nudges, last, calls, telling, retell, flush, rows } = s;
    tell(s);
    coach.teacherTurnDone();
    telling.resolve(ANALYSIS);
    await flush();
    coach.teacherTurnDone(); // → retelling

    coach.learnerSpeechStart();
    coach.learnerSaid("this is my app i built the login page", true);
    coach.learnerSpeechEnd(take(40_000, s.now()));
    assert.equal(coach.state, "retold");
    assert.equal(calls.retell.length, 1);
    assert.equal(calls.retell[0]?.first, ANALYSIS);
    assert.equal(calls.retell[0]?.transcriptHint, "this is my app i built the login page");

    coach.teacherTurnDone(); // 講評と質問が終わった
    assert.equal(coach.state, "answering");
    assert.deepEqual(last("retell_board")?.props.lines, [ANALYSIS.question]);
    assert.deepEqual(nudges.at(-1), { text: RETELL_ANSWER_NUDGE, mode: "next-turn" });

    coach.learnerSpeechStart();
    coach.learnerSaid("next i will add tests", true);
    coach.learnerSpeechEnd(take(8_000, s.now()));
    assert.equal(coach.state, "closing");
    coach.teacherTurnDone(); // 締めが終わった
    assert.equal(coach.state, "finished");
    assert.equal(last("retell_compare"), undefined); // 振り返り待ち
    assert.equal(rows.length, 0);

    retell.resolve(RETELL);
    await flush();
    const compare = last("retell_compare");
    assert.ok(compare);
    assert.equal(compare.props.first.seconds, 45);
    assert.equal(compare.props.first.transcript, ANALYSIS.transcript);
    assert.deepEqual(compare.props.first.points, ANALYSIS.points);
    assert.equal(compare.props.second?.transcript, RETELL.transcript);
    assert.equal(compare.props.second?.seconds, 40);
    assert.equal(compare.props.second?.words, 16);
    assert.equal(compare.props.improvements[0]?.used, true);
    assert.equal(compare.props.improvements[1]?.used, false);
    assert.equal(compare.props.comment, RETELL.comment);
    assert.deepEqual(compare.props.first.assessment, ANALYSIS.assessment);
    assert.deepEqual(compare.props.second?.assessment, RETELL.assessment);
    assert.deepEqual(compare.props.teaching, ANALYSIS.teaching);

    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.finished, true);
    assert.equal(row?.question, ANALYSIS.question);
    assert.equal(row?.answer, "next i will add tests");
    assert.equal(row?.comment, RETELL.comment);
    assert.equal(row?.improvements.length, 2);
    assert.deepEqual(row?.first?.assessment, ANALYSIS.assessment);
    assert.deepEqual(row?.second?.assessment, RETELL.assessment);
    assert.deepEqual(row?.teaching, ANALYSIS.teaching);
    // 終わった後は何も起きない
    coach.teacherTurnDone();
    assert.equal(coach.state, "finished");
    coach.dispose();
    assert.equal(rows.length, 1);
  });

  it("2回目の分析に失敗したら、字幕が一致しても採点と改善の判定は保留にする", async () => {
    const s = setup();
    const { coach, telling, retell, flush, last, rows } = s;
    tell(s);
    coach.teacherTurnDone();
    telling.resolve(ANALYSIS);
    await flush();
    coach.teacherTurnDone();
    coach.learnerSpeechStart();
    coach.learnerSaid("I built the login page. It was hard because of the API.", true);
    coach.learnerSpeechEnd(take(30_000, s.now()));
    retell.reject(new Error("analysis timed out"));
    await flush();
    coach.teacherTurnDone();
    coach.learnerSpeechStart();
    coach.learnerSpeechEnd(take(5_000, s.now()));
    coach.teacherTurnDone();

    const compare = last("retell_compare");
    assert.equal(coach.state, "finished");
    assert.ok(compare?.props.second);
    assert.equal(compare.props.second.assessment, undefined);
    assert.ok(compare.props.improvements.length > 0);
    assert.ok(compare.props.improvements.every((imp) => imp.used === undefined));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.second?.assessment, undefined);
    assert.ok(rows[0]?.improvements.every((imp) => imp.used === undefined));
    coach.dispose();
  });

  it("途中で終了しても、1回目があれば記録する(finished: false)", () => {
    const s = setup();
    const { coach, rows } = s;
    coach.dispose(); // 何も話していない → 記録しない
    assert.equal(rows.length, 0);

    const t = setup();
    tell(t);
    t.coach.dispose();
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0]?.finished, false);
    assert.equal(t.rows[0]?.first?.transcript, "this is my app i make login page"); // 整理が無いので字幕
    assert.equal(t.rows[0]?.second, undefined);
    assert.deepEqual(t.rows[0]?.improvements, []);
  });

  it("整理が長引くと、つなぎの一言を1回だけ頼む", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup();
    const { coach, nudges, telling, flush } = s;
    tell(s);
    coach.teacherTurnDone(); // 一言が終わった。整理はまだ
    const fillers = () => nudges.filter((n) => n.text === RETELL_FILLER_NUDGE).length;
    mock.timers.tick(7_000);
    assert.equal(fillers(), 1);
    coach.teacherTurnDone(); // つなぎの一言が終わった
    mock.timers.tick(7_000);
    assert.equal(fillers(), 1); // 二度目は無い
    telling.resolve(ANALYSIS);
    await flush();
    assert.equal(coach.state, "reviewing");
    coach.dispose();
    mock.timers.reset();
  });

  it("講評の途中で話し始めたら、話し直しとして扱う", async () => {
    const s = setup();
    const { coach, telling, flush, nudges } = s;
    tell(s);
    coach.teacherTurnDone();
    telling.resolve(ANALYSIS);
    await flush();
    assert.equal(coach.state, "reviewing");
    coach.learnerSpeechStart(); // 割り込み
    assert.equal(coach.state, "retelling");
    assert.equal(nudges.at(-1)?.mode, "next-turn");
    coach.teacherTurnDone(); // 割り込まれた講評のターンが閉じた → 何も起きない
    assert.equal(coach.state, "retelling");
    coach.dispose();
  });

  it("無音の声かけは挨拶のときだけ既定で、あとは出さない", () => {
    const { coach } = setup();
    assert.equal(coach.silenceNudge(), undefined);
    coach.onReady();
    coach.teacherTurnDone();
    assert.equal(coach.silenceNudge(), null);
    coach.dispose();
  });

  it("show_term_card はカードに、知らないツールは断る", () => {
    const { coach, last } = setup();
    const ok = coach.onToolCall("show_term_card", { term: "because of the API" });
    assert.equal(ok.response.shown, true);
    assert.equal(last("term_card")?.props.term, "because of the API");
    assert.equal(coach.onToolCall("show_recast", { original: "a", better: "b" }).response.shown, true); // 登録簿にはある
    assert.equal(coach.onToolCall("nope", {}).response.shown, false);
    coach.dispose();
  });
});

describe("countWords / usedInRetell", () => {
  it("英語の語数を数え、日本語は数えない", () => {
    assert.equal(countWords("I built the login page."), 5);
    assert.equal(countWords("えーと、login page を作りました"), 2);
    assert.equal(countWords(""), 0);
  });

  it("意味を確認した分析を優先し、単語の重なりだけで成功にしない", () => {
    assert.equal(usedInRetell("I built the login page", "so i built the login page yesterday"), true);
    assert.equal(usedInRetell("I built the login page", "", ["i built the login page."]), true);
    assert.equal(usedInRetell("I built the login page", "then I built a login page quickly"), false);
    assert.equal(usedInRetell("I built the login page", "I built the login page", []), false);
    assert.equal(usedInRetell("I built the login page", "I didn't build the login page"), false);
    assert.equal(usedInRetell("It was hard because of the API", "it was hard because the api changed", []), false);
    assert.equal(usedInRetell("", "anything", []), false);
  });
});
