import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewOutcome } from "../../shared/messages";
import type { DrillResultRow, ResultRow, ReviewResultRow } from "./results";
import { buildReviewCards, dailyReview, DAY_MS } from "./review";
import { parseScene } from "./scenes";

const NOW = Date.parse("2026-09-18T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const drill = (answer = "I worked yesterday.", verdict: DrillResultRow["verdict"] = "wrong", at = NOW - 2 * DAY_MS): DrillResultRow => ({
  kind: "drill", at: iso(at), scene: "work", round: 1, ja: "昨日働きました。", en: answer, verdict,
});
function reviewed(rows: ResultRow[], outcome: ReviewOutcome, at: number, eventId = String(at)): ReviewResultRow {
  const { dueAt, level, lapses, lastReviewAt, ...card } = buildReviewCards(rows)[0]!;
  return { kind: "review", at: iso(at), card, outcome, eventId, attempts: 1 };
}

describe("personal review schedule", () => {
  it("履歴なし・壊れた履歴は空の計画。ホームに答えを出さない", () => {
    assert.equal(dailyReview([], [], NOW).plan.total, 0);
    assert.equal(dailyReview([{ kind: "drill", at: iso(NOW) } as ResultRow], [], NOW).plan.total, 0);
    const { plan } = dailyReview([drill()], [], NOW);
    assert.equal(plan.items.length, 1);
    assert.ok(!JSON.stringify(plan).includes("I worked"));
    assert.equal(plan.estimatedMinutes, 3);
  });

  it("古い失敗と覚えた表現を集め、期限の来た3課題だけを出す", () => {
    const rows = [drill("one"), drill("two"), drill("three"), drill("four"), drill("future", "correct", NOW)];
    const { plan, cards } = dailyReview(rows, [], NOW);
    assert.equal(plan.total, 5);
    assert.equal(plan.due, 4);
    assert.equal(cards.length, 3);
    assert.equal(plan.nextDueAt, iso(NOW + DAY_MS));
  });

  it("各モードの訂正とコロケーションを集め、未使用の目標や正しい文の別案を誤りにしない", () => {
    const scene = parseScene({
      id: "work", title: "仕事", situation: "Work", targets: [
        { term: "work on", meaning: "取り組む", example: "I work on the app." },
        { term: "finish", meaning: "終える" },
      ],
    }, "work");
    const rows: ResultRow[] = [
      { kind: "scene", at: iso(NOW), scene: "work", term: "work on", status: "used_with_error" },
      { kind: "scene", at: iso(NOW), scene: "work", term: "finish", status: "unused" },
      { kind: "recast", at: iso(NOW), scene: "work", original: "I work.", better: "I have a job.", correctionKind: "upgrade" },
      { kind: "recast", at: iso(NOW), scene: "work", original: "I work yesterday", better: "I worked yesterday." },
      { kind: "retell", at: iso(NOW), prompts: [], improvements: [
        { original: "because API", better: "because of the API", used: false },
      ], finished: true, teaching: {
        collocation: { phrase: "make progress on", meaning: "進展する", example: "I made progress on the app." },
        practice: "今週進んだことを一文で話す",
      } },
    ];
    const cards = buildReviewCards(rows, [scene]);
    assert.equal(cards.length, 4);
    assert.equal(cards.filter((c) => c.kind === "repair").length, 2);
    assert.ok(!cards.some((c) => c.answer === "I have a job." || c.answer === "finish"));
    assert.equal(cards.find((c) => c.answer === "make progress on")?.cue, "今週進んだことを一文で話す");
  });

  it("自力成功なら1・3・7日と延ばし、読み直しても予定が変わらない", () => {
    const rows: ResultRow[] = [drill()];
    for (const [at, days] of [[NOW, 1], [NOW + DAY_MS, 3], [NOW + 4 * DAY_MS, 7]]) {
      rows.push(reviewed(rows, "independent", at!));
      assert.equal(buildReviewCards(rows)[0]?.dueAt, at! + days! * DAY_MS);
    }
    const recovered = JSON.parse(JSON.stringify(rows)) as ResultRow[];
    assert.deepEqual(dailyReview(recovered, [], NOW + 4 * DAY_MS), dailyReview(rows, [], NOW + 4 * DAY_MS));
  });

  it("同じ日の再成功・イベントの重複では間隔を二段伸ばさない", () => {
    const rows: ResultRow[] = [drill()];
    const result = reviewed(rows, "independent", NOW, "a");
    rows.push(result, result);
    rows.push(reviewed(rows, "independent", NOW + 1000, "b"));
    const card = buildReviewCards(rows)[0]!;
    assert.equal(card.level, 1);
    assert.equal(card.dueAt, NOW + DAY_MS);
    assert.equal(dailyReview(rows, [], NOW + 1000).plan.practicedToday, 1);
  });

  it("自己修正・ヒント・お手本の後の成功は翌日。失敗やスキップは10分後", () => {
    for (const outcome of ["repaired", "hinted", "modeled", "again", "skipped"] as const) {
      const rows: ResultRow[] = [drill()];
      rows.push(reviewed(rows, "independent", NOW - DAY_MS));
      rows.push(reviewed(rows, outcome, NOW));
      const card = buildReviewCards(rows)[0]!;
      assert.equal(card.level, 0);
      assert.equal(card.dueAt, NOW + (outcome === "again" || outcome === "skipped" ? 600_000 : DAY_MS));
    }
  });

  it("正しい通常練習で未消化の復習を延期せず、後日の間違いは復習を早める", () => {
    const rows: ResultRow[] = [drill(), { ...drill(), at: iso(NOW - DAY_MS), verdict: "correct", round: 2 }];
    assert.equal(dailyReview(rows, [], NOW).plan.due, 1);
    rows.push(reviewed(rows, "independent", NOW));
    rows.push(drill("I worked yesterday.", "wrong", NOW + 1000));
    assert.equal(dailyReview(rows, [], NOW + 1000).plan.due, 1);
  });

  it("元の問題ファイルがなくても復習結果のスナップショットから復旧する", () => {
    const result = reviewed([drill()], "hinted", NOW);
    assert.equal(buildReviewCards([result])[0]?.answer, "I worked yesterday.");
    assert.equal(buildReviewCards([{ ...result, card: { ...result.card, answer: "tampered" } }]).length, 0);
  });

  it("過去の練習課題に英語の表現が書かれていたら、答えのない日本語の課題にする", () => {
    const row = { ...drill(), teaching: {
      collocation: { phrase: "be blocked by + noun", meaning: "〜が原因で進められない。by の後に原因。", example: "I'm blocked by the API." },
      practice: "blocked by を使って、作業が止まった原因を説明してみよう。",
    } };
    const card = buildReviewCards([row]).find((c) => c.kind === "expression")!;
    assert.ok(card.cue.includes("原因で進められない"));
    assert.ok(!/[a-z]/i.test(card.cue));
  });
});
