import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saidBetter, wordDiff } from "../../shared/wordDiff";

const ops = (tokens: { text: string; op: string }[]) => tokens.map((t) => `${t.op[0]}:${t.text}`).join(" ");

describe("wordDiff", () => {
  it("消えた語と増えた語だけに印を付ける", () => {
    const d = wordDiff("I wait the API team answer.", "I'm blocked by the API team. I'm waiting for their answer.");
    assert.equal(ops(d.original), "r:I r:wait s:the s:API s:team s:answer.");
    assert.equal(ops(d.better), "a:I'm a:blocked a:by s:the s:API s:team. a:I'm a:waiting a:for a:their s:answer.");
  });

  it("大文字小文字と末尾の句読点は同じ語と見る", () => {
    const d = wordDiff("i am work the login bug", "I'm working on the login bug.");
    assert.equal(ops(d.original), "r:i r:am r:work s:the s:login s:bug");
    assert.equal(ops(d.better), "a:I'm a:working a:on s:the s:login s:bug.");
  });

  it("同じ文なら差分は無い", () => {
    const d = wordDiff("Nice to meet you.", "Nice to meet you.");
    assert.ok(d.original.every((t) => t.op === "same"));
    assert.ok(d.better.every((t) => t.op === "same"));
  });

  it("空文でも落ちない", () => {
    const d = wordDiff("", "Hello there.");
    assert.equal(d.original.length, 0);
    assert.equal(ops(d.better), "a:Hello a:there.");
  });
});

describe("saidBetter", () => {
  const d = wordDiff("I wait the API team answer.", "I'm blocked by the API team. I'm waiting for their answer.");

  it("増えた語をおおむね言えていれば言えたと見る", () => {
    assert.equal(saidBetter("I'm blocked by the API team, I'm waiting for their answer", d), true);
  });

  it("増えた語の大半を言っていなければ言えていない", () => {
    assert.equal(saidBetter("I wait for the API team", d), false);
  });

  it("差分が無い文は全語で見る", () => {
    const same = wordDiff("Nice to meet you.", "Nice to meet you.");
    assert.equal(saidBetter("nice to meet you", same), true);
    assert.equal(saidBetter("hello", same), false);
  });

  it("聞き取れなかった発話は言えたにしない", () => {
    assert.equal(saidBetter("", d), false);
  });
});
