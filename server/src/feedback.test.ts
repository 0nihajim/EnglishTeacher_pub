import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAssessment, parseTeachingNotes, teachingFromTool } from "./feedback";

describe("teaching notes", () => {
  it("使い分けや例文が欠けた提案は表示用データにしない", () => {
    assert.equal(parseTeachingNotes(null), undefined);
    assert.equal(parseTeachingNotes([]), undefined);
    assert.equal(parseTeachingNotes({ alternative: { phrase: "x" }, collocation: { phrase: "make progress" } }), undefined);
    assert.deepEqual(parseTeachingNotes({ practice: "  次の\n一文 " }), { practice: "次の 一文" });
  });

  it("平坦なLive引数を構造化し、モデルの長すぎる出力を制限する", () => {
    const notes = teachingFromTool({
      alternative: " I'm fixing the login bug. ",
      alternative_note: "修正中だと具体的に伝える",
      collocation: "work on + noun",
      collocation_note: "対象には on を使う",
      collocation_example: "I'm working on the login page.",
      practice: "x".repeat(300),
    });
    assert.deepEqual(notes?.alternative, { phrase: "I'm fixing the login bug.", usage: "修正中だと具体的に伝える" });
    assert.equal(notes?.collocation?.example, "I'm working on the login page.");
    assert.equal(notes?.practice?.length, 160);
    assert.equal(teachingFromTool({ alternative: 4, collocation: "<script>" }), undefined);
  });
});

describe("grounded assessment", () => {
  it("発話から引用した根拠がある点数だけを採用する", () => {
    const result = parseAssessment([
      { criterion: "grammar", score: 2, evidence: "I make login page", reason: "過去形と冠詞が必要" },
      { criterion: "range", score: 5, evidence: "Despite numerous obstacles", reason: "幅広い表現" },
    ], "This is my app. I make login page.");
    assert.equal(result?.[0]?.score, 2);
    assert.equal(result?.[1]?.score, null);
    assert.equal(result?.[1]?.evidence, "");
    assert.match(result?.[1]?.reason ?? "", /根拠が不足/);
  });

  it("空の根拠、範囲外、文字列、小数の点数を成功や0点に変換しない", () => {
    for (const score of [-1, 0, 6, 3.5, "4", NaN, undefined]) {
      assert.equal(parseAssessment([{ criterion: "grammar", score, evidence: "I work", reason: "理由" }], "I work")?.[0]?.score, null);
    }
    assert.equal(parseAssessment([{ criterion: "meaning", score: 5, evidence: "", reason: "理由" }], "I work")?.[0]?.score, null);
  });

  it("根拠不足の保留理由は残し、未知の軸・重複・理由のない値を除く", () => {
    const result = parseAssessment([
      { criterion: "pronunciation", score: 5, evidence: "I work", reason: "推測" },
      { criterion: "range", score: null, evidence: "", reason: "短すぎて表現の幅を判断できない" },
      { criterion: "range", score: 5, evidence: "I work", reason: "重複" },
      { criterion: "grammar", score: 4, evidence: "I work", reason: "" },
    ], "I work");
    assert.deepEqual(result, [{ criterion: "range", score: null, evidence: "", reason: "短すぎて表現の幅を判断できない" }]);
    assert.equal(parseAssessment({}, ""), undefined);
    assert.equal(parseAssessment([], ""), undefined);
  });

  it("表示順を一定にし、大文字・空白だけの違いは許す", () => {
    const result = parseAssessment([
      { criterion: "grammar", score: 4, evidence: "I BUILT", reason: "過去形" },
      { criterion: "meaning", score: 3, evidence: "login\npage", reason: "対象が明確" },
    ], "I built the login page.");
    assert.deepEqual(result?.map((item) => [item.criterion, item.score]), [["meaning", 3], ["grammar", 4]]);
  });
});
