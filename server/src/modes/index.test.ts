import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPlan } from "./index";
const store = { read: async () => [], append: async () => {} };

describe("personal review session plan", () => {
  it("シーンや画像なしで復習を組み、答えを公開する別モードのツールを渡さない", async () => {
    const plan = await buildPlan({ mode: "review", cards: [{
      id: "test", kind: "translation", cue: "昨日働きました", answer: "I worked yesterday.", source: "test",
    }] }, store);
    assert.equal(plan.mode, "review");
    assert.equal(plan.image, undefined);
    assert.deepEqual(plan.tools.map((tool) => tool.name), ["review_result"]);
    assert.ok(plan.tools[0]?.required.includes("attempt_id"));
    assert.ok(!plan.greeting.includes("I worked"));
  });

  it("期限の来た課題がなければ空の復習セッションを作らない", async () => {
    await assert.rejects(buildPlan({ mode: "review", cards: [] }, store), /課題がありません/);
  });
});

describe("whiteboard session plan", () => {
  it("シーンも画像も要らず、表示のツールだけを渡し、進行の判定ツールは渡さない", async () => {
    const plan = await buildPlan({ mode: "whiteboard" }, store);
    assert.equal(plan.mode, "whiteboard");
    assert.equal(plan.image, undefined);
    assert.equal(plan.captureSpeech, undefined);
    assert.deepEqual(plan.tools.map((tool) => tool.name), ["show_recast", "show_term_card", "hide_card"]);
    assert.match(plan.systemInstruction, /whiteboard/i);
    assert.match(plan.systemInstruction, /newest picture/);
    assert.match(plan.greeting, /ボード/);
  });
});
