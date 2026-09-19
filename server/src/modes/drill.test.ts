import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { DrillVerdict, UiMessage } from "../../../shared/messages";
import type { NudgeMode } from "../gemini";
import { DRILL_REPORT_REMINDER } from "../prompts";
import type { DrillResultRow } from "../results";
import { parseScene } from "../scenes";
import { DrillRunner, orderDrills, parseVerdict } from "./drill";
import type { CoachHost } from "./types";

type Widget = UiMessage["widget"];
type Of<W extends Widget> = Extract<UiMessage, { widget: W }>;

function setup(overrides: { lastVerdicts?: Map<string, DrillVerdict>; promptVoice?: boolean } = {}) {
  const ui: UiMessage[] = [];
  const nudges: { text: string; mode: NudgeMode }[] = [];
  const rows: DrillResultRow[] = [];
  let speaking = false;
  let now = 0;
  const host: CoachHost = {
    showUi: (u) => ui.push(u),
    nudge: (text, mode) => nudges.push({ text, mode }),
    log: () => {},
    teacherSpeaking: () => speaking,
  };
  const scene = parseScene(
    {
      title: "テスト",
      situation: "s",
      promptVoice: overrides.promptVoice ?? true,
      targets: [{ term: "one", meaning: "一" }],
      drills: [
        { ja: "一", en: "one" },
        { ja: "二", en: "two", accept: ["2"] },
        { ja: "三", en: "three" },
      ],
    },
    "test",
  );
  const runner = new DrillRunner(host, scene, {
    shuffle: false,
    repeatMissed: true,
    clock: () => now,
    random: () => 0,
    lastVerdicts: overrides.lastVerdicts ?? new Map(),
    limitMs: 5_000,
    onOutcome: (row) => rows.push(row),
  });
  const last = <W extends Widget>(widget: W): Of<W> | undefined =>
    ui.filter((u): u is Of<W> => u.widget === widget).at(-1);
  return {
    ui,
    nudges,
    rows,
    runner,
    last,
    setSpeaking: (v: boolean) => {
      speaking = v;
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("DrillRunner", () => {
  it("挨拶のターンが終わると最初の問題を出す(カードと now の nudge)", () => {
    const { runner, nudges, last } = setup();
    assert.equal(runner.state, "greeting");
    runner.teacherTurnDone();
    assert.equal(runner.state, "prompting");
    assert.deepEqual(last("drill_prompt")?.props, { index: 1, total: 3, ja: "一", limitMs: 5_000 });
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]?.mode, "now");
    assert.ok(nudges[0]?.text.includes("「一」"));
    assert.ok(nudges[0]?.text.includes('"one"'));
    runner.dispose();
  });

  it("読み終えてから時計が動き、答え始めるまでを測る。判定でカードが出て、講評が終わると次へ", () => {
    const { runner, nudges, last, rows, setSpeaking, tick } = setup();
    runner.teacherTurnDone(); // 挨拶 → 問題1
    tick(2_000);
    runner.teacherTurnDone(); // 読み終えた
    assert.equal(runner.state, "answering");
    tick(1_500);
    runner.learnerSaid("one", false);
    setSpeaking(true);
    const reply = runner.onToolCall("drill_result", { verdict: "correct" });
    assert.equal(reply.response.recorded, true);
    assert.equal(reply.scheduling, "SILENT");
    assert.equal(runner.state, "judging");
    assert.deepEqual(last("drill_answer")?.props, {
      ja: "一",
      answer: "one",
      verdict: "correct",
      said: "one",
      latencyMs: 1_500,
    });
    assert.equal(rows.at(-1)?.verdict, "correct");
    assert.equal(rows.at(-1)?.latencyMs, 1_500);
    assert.equal(nudges.length, 1); // 先生が喋っている間は次を出さない
    setSpeaking(false);
    runner.teacherTurnDone(); // 講評が終わった
    assert.equal(last("drill_prompt")?.props.index, 2);
    assert.equal(nudges.length, 2);
    assert.ok(nudges[1]?.text.includes('別解: "2"'));
    runner.dispose();
  });

  it("判定がターンの後に来たら、待たずに次へ", () => {
    const { runner, last } = setup();
    runner.teacherTurnDone();
    runner.teacherTurnDone();
    runner.learnerSaid("one", true);
    runner.onToolCall("drill_result", { verdict: "close", said: "wan", note: "母音" });
    assert.equal(runner.state, "prompting");
    assert.equal(last("drill_prompt")?.props.index, 2);
    assert.equal(last("drill_answer")?.props.said, "wan"); // 先生の聞き取りが文字起こしより優先
    assert.equal(last("drill_answer")?.props.note, "母音");
    runner.dispose();
  });

  it("別解の使い分け・コロケーション・練習課題をカードと記録に残す", () => {
    const { runner, last, rows, setSpeaking } = setup();
    runner.teacherTurnDone();
    runner.teacherTurnDone();
    setSpeaking(true);
    runner.onToolCall("drill_result", {
      verdict: "correct",
      said: "one",
      alternative: "a single one",
      alternative_note: "一つだけだと強調する",
      collocation: "one at a time",
      collocation_note: "一度に一つずつ",
      collocation_example: "Please send them one at a time.",
      practice: "一つずつしてほしいことを頼んでみよう",
    });
    const notes = last("drill_answer")?.props.teaching;
    assert.equal(notes?.alternative?.usage, "一つだけだと強調する");
    assert.equal(notes?.collocation?.phrase, "one at a time");
    assert.deepEqual(rows[0]?.teaching, notes);
    assert.deepEqual(runner.results[0]?.teaching, notes);
    runner.dispose();
  });

  it("制限時間を過ぎて答えが無ければヒントを頼む。答え始めていれば頼まない", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { runner, nudges } = setup();
    runner.teacherTurnDone();
    runner.teacherTurnDone(); // answering、時計スタート
    mock.timers.tick(5_000);
    // 出題の文にも「ヒント」の語が入るので、ヒントの nudge だけに出る言い方で数える
    const hints = () => nudges.filter((n) => n.text.includes("最初の2〜3語"));
    assert.equal(hints().length, 1);
    assert.equal(hints()[0]?.mode, "now");
    // 次の問題では学習者が先に話し始める → ヒントは出ない
    runner.onToolCall("drill_result", { verdict: "wrong" }); // 先生は喋っていない → すぐ次へ
    runner.teacherTurnDone(); // 読み終えた
    runner.learnerSpeaking();
    mock.timers.tick(5_000);
    assert.equal(hints().length, 1);
    runner.dispose();
    mock.timers.reset();
  });

  it("スキップは skipped で記録し、正解を言ってから次を出す", () => {
    const { runner, nudges, last, setSpeaking } = setup();
    runner.teacherTurnDone();
    runner.teacherTurnDone();
    runner.onControl("skip");
    assert.equal(last("drill_answer")?.props.verdict, "skipped");
    assert.ok(nudges.at(-1)?.text.startsWith("学習者が前の問題をスキップした"));
    assert.ok(nudges.at(-1)?.text.includes('"one"'));
    assert.equal(last("drill_prompt")?.props.index, 2);
    // 判定が済んで講評中のスキップは無視(もう次へ進む途中)
    runner.teacherTurnDone(); // 読み終えた
    runner.learnerSaid("two", true);
    setSpeaking(true);
    runner.onToolCall("drill_result", { verdict: "correct" });
    runner.onControl("skip");
    assert.equal(last("drill_prompt")?.props.index, 2);
    assert.equal(last("drill_answer")?.props.verdict, "correct");
    runner.dispose();
  });

  it("間違えた問題は最後にもう一周し、全部終わるとまとめを出す", () => {
    const { runner, nudges, last, rows } = setup();
    const answer = (verdict: DrillVerdict) => {
      runner.teacherTurnDone(); // 読み終えた
      runner.learnerSaid("x", true);
      runner.onToolCall("drill_result", { verdict }); // 先生は喋っていない → すぐ次へ
    };
    runner.teacherTurnDone(); // 挨拶 → 1
    answer("correct"); // → 2
    answer("wrong"); // → 3
    answer("correct"); // → 2周目: 二
    assert.deepEqual(last("drill_prompt")?.props, { index: 1, total: 1, ja: "二", limitMs: 5_000 });
    assert.ok(nudges.at(-1)?.text.includes("間違えた問題をもう一度"));
    answer("correct"); // → 終わり
    assert.equal(runner.state, "finished");
    const summary = last("summary");
    assert.ok(summary);
    assert.equal(summary.props.lines.length, 4);
    assert.ok(summary.props.lines[3]?.label.startsWith("再 "));
    assert.ok(summary.props.footer?.startsWith("正解 3 / 4"));
    assert.ok(nudges.at(-1)?.text.includes("正解 3/4"));
    assert.ok(nudges.at(-1)?.text.includes("最終的には全部言えた"));
    assert.equal(rows.length, 4);
    // 終わった後は何も起きない
    runner.teacherTurnDone();
    assert.equal(runner.state, "finished");
    runner.dispose();
  });

  it("無音のとき: 答えていなければ正解を言わせ、答えたのに判定が無ければ催促し、判定の後なら自分で次へ", () => {
    const { runner, last, setSpeaking } = setup();
    runner.teacherTurnDone();
    runner.teacherTurnDone(); // answering
    assert.ok(runner.silenceNudge()?.includes("skipped"));
    runner.learnerSaid("one", false);
    assert.equal(runner.silenceNudge(), DRILL_REPORT_REMINDER);
    setSpeaking(true);
    runner.onToolCall("drill_result", { verdict: "close" }); // 講評のターンが閉じるのを待つ
    assert.equal(runner.state, "judging");
    assert.equal(runner.silenceNudge(), null); // 自分で進んだ
    assert.equal(last("drill_prompt")?.props.index, 2);
    runner.dispose();
  });

  it("前回間違えた問題を先に出す", () => {
    const { runner, last } = setup({ lastVerdicts: new Map([["three", "wrong"]]) });
    runner.teacherTurnDone();
    assert.equal(last("drill_prompt")?.props.ja, "三");
    runner.dispose();
  });

  it("問題が開いていないときの報告と、不正な verdict は記録しない", () => {
    const { runner } = setup();
    assert.equal(runner.onToolCall("drill_result", { verdict: "correct" }).response.recorded, false);
    runner.teacherTurnDone();
    assert.equal(runner.onToolCall("drill_result", { verdict: "maybe" }).response.recorded, false);
    assert.equal(runner.onToolCall("nope", {}).response.shown, false);
    runner.dispose();
  });

  it("promptVoice=false でも流れは同じで、読み上げない指示になる", () => {
    const { runner, nudges } = setup({ promptVoice: false });
    runner.teacherTurnDone();
    assert.ok(nudges[0]?.text.includes("Next."));
    assert.ok(!nudges[0]?.text.includes("読み上げ"));
    runner.dispose();
  });
});

describe("orderDrills / parseVerdict", () => {
  it("前回間違えたものを先に、あとは元の順", () => {
    const items = [
      { ja: "1", en: "a", accept: [] },
      { ja: "2", en: "b", accept: [] },
      { ja: "3", en: "c", accept: [] },
    ];
    const last = new Map<string, DrillVerdict>([
      ["a", "correct"],
      ["c", "skipped"],
    ]);
    assert.deepEqual(
      orderDrills(items, { shuffle: false, random: () => 0, lastVerdicts: last }).map((i) => i.en),
      ["c", "a", "b"],
    );
  });

  it("verdict は大文字小文字と空白を許し、知らない値は捨てる", () => {
    assert.equal(parseVerdict(" Correct "), "correct");
    assert.equal(parseVerdict("SKIPPED"), "skipped");
    assert.equal(parseVerdict("maybe"), undefined);
    assert.equal(parseVerdict(1), undefined);
  });
});
