import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecastProps, UiMessage } from "../../../shared/messages";
import type { NudgeMode } from "../gemini";
import { SCENE_ALL_DONE_NUDGE } from "../prompts";
import type { SceneResultRow } from "../results";
import { parseScene } from "../scenes";
import { SceneCoach } from "./scene";
import type { CoachHost } from "./types";

type Widget = UiMessage["widget"];
type Of<W extends Widget> = Extract<UiMessage, { widget: W }>;

function setup() {
  const ui: UiMessage[] = [];
  const nudges: { text: string; mode: NudgeMode }[] = [];
  const rows: SceneResultRow[] = [];
  const feedback: RecastProps[] = [];
  const host: CoachHost = {
    showUi: (u) => ui.push(u),
    nudge: (text, mode) => nudges.push({ text, mode }),
    log: () => {},
    teacherSpeaking: () => false,
  };
  const scene = parseScene(
    {
      title: "朝会",
      situation: "s",
      targets: [
        { term: "I'm working on", meaning: "取り組む", variants: ["I am working on"] },
        { term: "blocked by", meaning: "止まる" },
        { term: "roll out", meaning: "出す" },
      ],
    },
    "standup",
  );
  const coach = new SceneCoach(host, scene, {
    steerEvery: 2, clock: () => 0, onOutcome: (r) => rows.push(...r), onFeedback: (f) => feedback.push(f),
  });
  const last = <W extends Widget>(widget: W): Of<W> | undefined =>
    ui.filter((u): u is Of<W> => u.widget === widget).at(-1);
  const statuses = () => Object.fromEntries(coach.targets.map((t) => [t.term, t.status]));
  return { ui, nudges, rows, feedback, coach, last, statuses };
}

describe("SceneCoach", () => {
  it("目標以外の訂正も、コロケーションと一緒に復習用の保存先へ渡す", () => {
    const { coach, feedback } = setup();
    coach.onToolCall("show_recast", {
      original: "I make progress yesterday", better: "I made progress yesterday.",
      kind: "correction", collocation: "make progress", collocation_note: "進展する",
      collocation_example: "We made progress on the app.",
    });
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]?.better, "I made progress yesterday.");
    assert.equal(feedback[0]?.teaching?.collocation?.phrase, "make progress");
    coach.dispose();
  });
  it("開始時に表現の一覧を出す(全部 unused)", () => {
    const { coach, last } = setup();
    coach.onReady();
    const panel = last("targets");
    assert.equal(panel?.props.title, "朝会");
    assert.deepEqual(
      panel?.props.targets.map((t) => t.status),
      ["unused", "unused", "unused"],
    );
    coach.dispose();
  });

  it("学習者が表現(別形も)を口にすると heard になり、一覧が更新される", () => {
    const { coach, last, statuses, ui } = setup();
    coach.learnerSaid("I am working on the login bug", false);
    assert.equal(statuses()["I'm working on"], "heard");
    assert.equal(statuses()["blocked by"], "unused");
    assert.equal(last("targets")?.props.targets[0]?.status, "heard");
    // 単語の途中では反応しない
    const before = ui.length;
    coach.learnerSaid("the payroll outage is fixed", true);
    assert.equal(statuses()["roll out"], "unused");
    assert.equal(ui.length, before);
    coach.dispose();
  });

  it("先生が口にすると modeled、学習者が言えば heard に上がり、逆には戻らない", () => {
    const { coach, statuses } = setup();
    coach.teacherSaid("Are you blocked by anything today?");
    assert.equal(statuses()["blocked by"], "modeled");
    coach.learnerSaid("I'm blocked by the API change", true);
    assert.equal(statuses()["blocked by"], "heard");
    coach.teacherSaid("So you're blocked by the API.");
    assert.equal(statuses()["blocked by"], "heard");
    coach.dispose();
  });

  it("report_target は先生の判定で上げる。下げない。未知の表現と不正な outcome は断る", () => {
    const { coach, statuses } = setup();
    coach.learnerSaid("I'm working on it", true);
    const ok = coach.onToolCall("report_target", { term: "I'm working on", outcome: "used_with_error", note: "時制" });
    assert.equal(ok.response.recorded, true);
    assert.equal(statuses()["I'm working on"], "used_with_error");
    // modeled は used_with_error より弱いので戻らない
    coach.onToolCall("report_target", { term: "i m working on", outcome: "modeled" });
    assert.equal(statuses()["I'm working on"], "used_with_error");
    coach.onToolCall("report_target", { term: "I'm working on", outcome: "Used_Well" });
    assert.equal(statuses()["I'm working on"], "used_well");
    assert.equal(coach.onToolCall("report_target", { term: "synergy", outcome: "used_well" }).response.recorded, false);
    assert.equal(coach.onToolCall("report_target", { term: "roll out", outcome: "great" }).response.recorded, false);
    // まとめには先生の一言が載る
    const line = coach.summary().lines[0];
    assert.equal(line?.tone, "good");
    assert.ok(line?.value.includes("時制"));
    coach.dispose();
  });

  it("先生のターンが一定回数終わるごとに、未使用の表現の機会を頼む(next-turn、未使用を優先して最大2つ)", () => {
    const { coach, nudges } = setup();
    coach.teacherSaid("Let's roll out the plan."); // roll out は modeled
    coach.teacherTurnDone();
    assert.equal(nudges.length, 0);
    coach.teacherTurnDone();
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]?.mode, "next-turn");
    assert.ok(nudges[0]?.text.includes('"I\'m working on"'));
    assert.ok(nudges[0]?.text.includes('"blocked by"'));
    assert.ok(!nudges[0]?.text.includes('"roll out"'));
    coach.dispose();
  });

  it("全部口にしただけでは完了せず、正しい使用を確認してから締める", () => {
    const { coach, nudges } = setup();
    coach.learnerSaid("I'm working on it, I'm blocked by the API, and we roll out Friday", true);
    coach.teacherTurnDone();
    assert.equal(nudges.length, 0);
    coach.onToolCall("report_target", { term: "I'm working on", outcome: "used_well" });
    coach.onToolCall("report_target", { term: "blocked by", outcome: "used_well" });
    coach.onToolCall("report_target", { term: "roll out", outcome: "used_with_error" });
    assert.match(coach.summary().footer ?? "", /正しく使えた 2 \/ 3/);
    coach.onToolCall("report_target", { term: "roll out", outcome: "used_well" });
    coach.teacherTurnDone();
    assert.deepEqual(nudges, [{ text: SCENE_ALL_DONE_NUDGE, mode: "next-turn" }]);
    coach.teacherTurnDone();
    coach.teacherTurnDone();
    assert.equal(nudges.length, 1);
    coach.dispose();
  });

  it("show_progress はまとめを出し、状態を返す(WHEN_IDLE)", () => {
    const { coach, last } = setup();
    coach.learnerSaid("I'm working on it", true);
    const reply = coach.onToolCall("show_progress", { title: "x" });
    assert.equal(reply.scheduling, "WHEN_IDLE");
    assert.deepEqual(
      (reply.response.targets as { term: string; status: string }[]).map((t) => t.status),
      ["heard", "unused", "unused"],
    );
    const summary = last("summary");
    assert.equal(summary?.props.lines.length, 3);
    assert.equal(summary?.props.footer, "正しく使えた 0 / 3 · 要確認・要修正 1");
    coach.dispose();
  });

  it("show_recast はカードを出す", () => {
    const { coach, last } = setup();
    const reply = coach.onToolCall("show_recast", { original: "I do the bug now.", better: "I'm working on the bug." });
    assert.equal(reply.response.shown, true);
    assert.deepEqual(last("recast")?.props, { original: "I do the bug now.", better: "I'm working on the bug." });
    coach.dispose();
  });

  it("dispose で表現ごとの記録を渡す", () => {
    const { coach, rows } = setup();
    coach.learnerSaid("I'm working on the bug", true);
    coach.dispose();
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.kind, "scene");
    assert.equal(rows[0]?.status, "heard");
    assert.equal(rows[0]?.said, "I'm working on the bug");
    assert.equal(rows[1]?.status, "unused");
    coach.dispose(); // 二度目は何もしない
    assert.equal(rows.length, 3);
  });
});
