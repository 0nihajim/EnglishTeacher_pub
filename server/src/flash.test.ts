import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalysisError, parseRetellAnalysis, parseTellingAnalysis } from "./flash";
import { DEFAULT_RETELL_QUESTION } from "./prompts";

describe("parseTellingAnalysis", () => {
  it("項目を整え、改善点は2つまで、壊れた改善点は落とす", () => {
    const out = parseTellingAnalysis({
      transcript: "  This is  my app.\nI make login page. ",
      points: ["アプリ", "", "ログイン", 3, "API", "五", "六", "七"],
      improvements: [
        { original: "I make login page", better: "I built the login page", note: "  過去 " },
        { original: "x", better: "" },
        { better: "y" },
        { original: "It was difficult because API", better: "It was hard because of the API" },
        { original: "third", better: "fourth" },
      ],
      keywords: ["my app", "login", "built", "API", "next", "six", "seven"],
      question: "What will you work on next?",
    });
    assert.equal(out.transcript, "This is my app. I make login page.");
    assert.deepEqual(out.points, ["アプリ", "ログイン", "API", "五", "六"]);
    assert.deepEqual(out.improvements, [
      { original: "I make login page", better: "I built the login page", note: "過去" },
      { original: "It was difficult because API", better: "It was hard because of the API" },
    ]);
    assert.deepEqual(out.keywords, ["my app", "login", "built", "API", "next", "six"]);
    assert.equal(out.question, "What will you work on next?");
  });

  it("欠けは埋め、長すぎる値は切る", () => {
    const out = parseTellingAnalysis({ transcript: "x".repeat(3_000) });
    assert.equal(out.transcript.length, 2_000);
    assert.deepEqual(out.points, []);
    assert.deepEqual(out.improvements, []);
    assert.deepEqual(out.keywords, []);
    assert.equal(out.question, DEFAULT_RETELL_QUESTION);
  });

  it("オブジェクトでなければ落ちる", () => {
    assert.throws(() => parseTellingAnalysis("nope"), AnalysisError);
    assert.throws(() => parseTellingAnalysis(null), AnalysisError);
    assert.throws(() => parseTellingAnalysis([1]), AnalysisError);
  });

  it("構造化された指導と根拠つき評価を返し、架空の引用では採点しない", () => {
    const result = parseTellingAnalysis({
      transcript: "I make login page.",
      teaching: { alternative: { phrase: "I created the login page.", usage: "過去の作業を端的に伝える" } },
      assessment: [
        { criterion: "grammar", score: 2, evidence: "I make login page", reason: "過去形と冠詞" },
        { criterion: "range", score: 5, evidence: "sophisticated", reason: "豊かな表現" },
      ],
    });
    assert.equal(result.teaching?.alternative?.phrase, "I created the login page.");
    assert.equal(result.assessment?.[0]?.score, 2);
    assert.equal(result.assessment?.[1]?.score, null);
    const second = parseRetellAnalysis({
      transcript: "I built the login page.",
      assessment: [{ criterion: "grammar", score: 4, evidence: "I built", reason: "過去形" }],
    });
    assert.equal(second.assessment?.[0]?.score, 4);
  });
});

describe("parseRetellAnalysis", () => {
  it("使えた言い方は2つまで、一言は1行に", () => {
    const out = parseRetellAnalysis({
      transcript: "I built the login page.",
      points: ["ログイン"],
      used: ["I built the login page", "b", "c"],
      comment: "時制が\n安定した",
    });
    assert.deepEqual(out.used, ["I built the login page", "b"]);
    assert.equal(out.comment, "時制が 安定した");
    assert.deepEqual(out.points, ["ログイン"]);
  });

  it("欠けは空に", () => {
    const out = parseRetellAnalysis({});
    assert.deepEqual(out, { transcript: "", points: [], used: [], comment: "" });
    assert.throws(() => parseRetellAnalysis(42), AnalysisError);
  });
});
