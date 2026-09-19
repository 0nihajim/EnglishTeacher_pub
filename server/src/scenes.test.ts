import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadScenes, parseScene, SceneError } from "./scenes";

describe("parseScene", () => {
  it("最小の定義を読み、drills を targets から作る", () => {
    const scene = parseScene(
      { title: "t", situation: "s", targets: [{ term: "a", meaning: "あ", variants: ["b"] }] },
      "x",
    );
    assert.equal(scene.id, "x");
    assert.equal(scene.promptVoice, true);
    assert.equal(scene.drillLimitMs, 8_000);
    assert.equal(scene.learnerRole, undefined);
    assert.deepEqual(scene.drills, [{ ja: "あ", en: "a", accept: ["b"] }]);
  });

  it("id はファイル名を既定にし、書いてあれば形式を検査する", () => {
    assert.throws(
      () => parseScene({ id: "Bad Id", title: "t", situation: "s", targets: [{ term: "a", meaning: "あ" }] }, "x"),
      SceneError,
    );
    const scene = parseScene({ id: "ok-1_a", title: "t", situation: "s", targets: [{ term: "a", meaning: "あ" }] }, "x");
    assert.equal(scene.id, "ok-1_a");
  });

  it("必須が欠けたら場所つきで落ちる", () => {
    assert.throws(() => parseScene({ situation: "s", targets: [{ term: "a", meaning: "あ" }] }, "x"), /"title"/);
    assert.throws(() => parseScene({ title: "t", situation: "s", targets: [] }, "x"), /"targets"/);
    assert.throws(() => parseScene({ title: "t", situation: "s", targets: [{ term: "a" }] }, "x"), /targets\[0\].*"meaning"/);
    assert.throws(
      () => parseScene({ title: "t", situation: "s", targets: [{ term: "a", meaning: "あ" }], drills: [{ ja: "一" }] }, "x"),
      /drills\[0\].*"en"/,
    );
    assert.throws(() => parseScene("nope", "x"), SceneError);
  });

  it("任意項目は型を検査する", () => {
    const base = { title: "t", situation: "s", targets: [{ term: "a", meaning: "あ" }] };
    assert.throws(() => parseScene({ ...base, targets: [{ term: "a", meaning: "あ", variants: [1] }] }, "x"), /"variants"/);
    assert.throws(() => parseScene({ ...base, promptVoice: "yes" }, "x"), /"promptVoice"/);
    assert.throws(() => parseScene({ ...base, drillLimitMs: 10 }, "x"), /"drillLimitMs"/);
    assert.throws(() => parseScene({ ...base, drills: "many" }, "x"), /"drills"/);
  });

  it("空文字の任意項目は無かったことにし、長すぎる値は切る", () => {
    const scene = parseScene(
      {
        title: "t",
        situation: "s",
        learnerRole: "",
        targets: [{ term: "a", meaning: "あ", reading: "", example: "x".repeat(300) }],
      },
      "x",
    );
    assert.equal(scene.learnerRole, undefined);
    assert.equal(scene.targets[0]?.reading, undefined);
    assert.equal(scene.targets[0]?.example?.length, 200);
  });
});

describe("loadScenes", () => {
  it("同梱のシーンが全部読める", () => {
    const { scenes, errors } = loadScenes();
    assert.deepEqual(errors, []);
    const ids = scenes.map((s) => s.id);
    assert.ok(ids.includes("self-intro"));
    assert.ok(ids.includes("it-standup"));
    for (const scene of scenes) {
      assert.ok(scene.targets.length > 0);
      assert.ok(scene.drills.length > 0);
    }
  });
});
