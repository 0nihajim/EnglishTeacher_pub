import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Turn } from "../../shared/messages";
import { TurnProjector, type TurnGaps } from "./turns";

function collect(gaps: TurnGaps = { user: 1_000 }) {
  const turns: Turn[] = [];
  const projector = new TurnProjector({ onTurn: (t) => turns.push(t) }, gaps);
  return { turns, projector };
}

describe("TurnProjector", () => {
  it("断片を同じ id に連結し、close で done を送る", () => {
    const { turns, projector } = collect();
    projector.fragment("assistant", "Nice to ");
    projector.fragment("assistant", "meet you.");
    projector.close("assistant");
    assert.deepEqual(
      turns.map((t) => [t.id, t.text, t.done]),
      [
        ["assistant_1", "Nice to ", false],
        ["assistant_1", "Nice to meet you.", false],
        ["assistant_1", "Nice to meet you.", true],
      ],
    );
    projector.dispose();
  });

  it("学習者側は無音のギャップで閉じる", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { turns, projector } = collect();
    projector.fragment("user", "Hello");
    mock.timers.tick(600);
    projector.fragment("user", " there"); // ギャップの時計を張り直す
    mock.timers.tick(999);
    assert.equal(turns.at(-1)?.done, false);
    mock.timers.tick(1);
    assert.equal(turns.at(-1)?.done, true);
    assert.equal(turns.at(-1)?.text, "Hello there");
    projector.dispose();
    mock.timers.reset();
  });

  it("先生側はギャップでは閉じず、close の明示でだけ閉じる", () => {
    // 出力の文字起こしは音声と一緒にまとめて届き、その後 turnComplete まで何も
    // 来ない。そこで閉じると字幕が割れ、「ターンが終わった」が再生中に発火する。
    mock.timers.enable({ apis: ["setTimeout"] });
    const { turns, projector } = collect();
    projector.fragment("assistant", "Let me ");
    mock.timers.tick(10_000);
    projector.fragment("assistant", "think.");
    assert.equal(turns.filter((t) => t.done).length, 0);
    assert.equal(turns.at(-1)?.id, "assistant_1");
    assert.equal(turns.at(-1)?.text, "Let me think.");
    projector.close("assistant");
    assert.equal(turns.at(-1)?.done, true);
    projector.dispose();
    mock.timers.reset();
  });

  it("finished 付きの断片はその場で閉じる", () => {
    const { turns, projector } = collect();
    projector.fragment("user", "Hello", true);
    assert.deepEqual(
      turns.map((t) => [t.id, t.text, t.done]),
      [
        ["user_1", "Hello", false],
        ["user_1", "Hello", true],
      ],
    );
    projector.fragment("user", "Again");
    assert.equal(turns.at(-1)?.id, "user_2");
    projector.dispose();
  });

  it("空の断片に finished だけ付いていても、開いている行を閉じる", () => {
    const { turns, projector } = collect();
    projector.fragment("user", "Hello");
    projector.fragment("user", "", true);
    assert.equal(turns.at(-1)?.done, true);
    assert.equal(turns.length, 2);
    // 開いていなければ何も起きない
    projector.fragment("user", "", true);
    assert.equal(turns.length, 2);
    projector.dispose();
  });

  it("isOpen は開いている役だけ true", () => {
    const { projector } = collect();
    assert.equal(projector.isOpen("user"), false);
    projector.fragment("user", "a");
    assert.equal(projector.isOpen("user"), true);
    assert.equal(projector.isOpen("assistant"), false);
    projector.close("user");
    assert.equal(projector.isOpen("user"), false);
    projector.dispose();
  });

  it("閉じていない役の close は何もしない", () => {
    const { turns, projector } = collect();
    projector.close("assistant");
    assert.equal(turns.length, 0);
    projector.dispose();
  });

  it("役ごとに独立した id を振る", () => {
    const { turns, projector } = collect();
    projector.fragment("assistant", "a");
    projector.fragment("user", "b");
    projector.close("assistant");
    projector.fragment("assistant", "c");
    const ids = new Set(turns.map((t) => t.id));
    assert.deepEqual([...ids], ["assistant_1", "user_2", "assistant_3"]);
    projector.dispose();
  });
});
