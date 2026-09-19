import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchToolCall } from "./tools";

describe("dispatchToolCall", () => {
  it("未知の名前は null", () => {
    assert.equal(dispatchToolCall("nope", {}), null);
  });

  it("show_term_card: 文字列を整え、空の任意項目は載せない", () => {
    const out = dispatchToolCall("show_term_card", {
      term: "  Could you say that again?  ",
      reading: "",
      meaning: 42,
      example: "x".repeat(300),
    });
    assert.ok(out);
    assert.deepEqual(out.ui, {
      widget: "term_card",
      props: { term: "Could you say that again?", example: "x".repeat(200) },
    });
    assert.equal(out.reply.scheduling, "SILENT");
  });

  it("show_term_card: term が無ければ null(引数が壊れている)", () => {
    assert.equal(dispatchToolCall("show_term_card", { reading: "a" }), null);
  });

  it("hide_card: カードを消す", () => {
    const out = dispatchToolCall("hide_card", { reason: "終わった" });
    assert.deepEqual(out?.ui, { widget: "hide", props: {} });
    assert.equal(out?.reply.scheduling, "SILENT");
  });

  it("show_recast: 学習者の文と言い直しを並べる。どちらか欠けたら null", () => {
    const out = dispatchToolCall("show_recast", {
      original: " I do the bug now. ",
      better: "I'm working on the bug.",
      note: "",
    });
    assert.ok(out);
    assert.deepEqual(out.ui, {
      widget: "recast",
      props: { original: "I do the bug now.", better: "I'm working on the bug." },
    });
    assert.equal(out.reply.scheduling, "SILENT");
    assert.equal(dispatchToolCall("show_recast", { original: "x" }), null);
  });

  it("進行に関わるツールはここでは扱わない(コーチが受ける)", () => {
    assert.equal(dispatchToolCall("report_target", { term: "a", outcome: "used_well" }), null);
    assert.equal(dispatchToolCall("show_progress", { title: "x" }), null);
    assert.equal(dispatchToolCall("drill_result", { verdict: "correct" }), null);
  });

  it("正しい文の別案を訂正と区別し、使い分けを届ける", () => {
    const result = dispatchToolCall("show_recast", {
      original: "I'm working on the login bug.",
      better: "I'm fixing the login bug.",
      kind: "upgrade",
      note: "元の文も正しい",
      alternative: "I'm investigating the login issue.",
      alternative_note: "原因の調査中である場合の言い方",
    });
    assert.ok(result?.ui?.widget === "recast");
    assert.equal(result.ui.props.kind, "upgrade");
    assert.equal(result.ui.props.teaching?.alternative?.usage, "原因の調査中である場合の言い方");
  });
});
