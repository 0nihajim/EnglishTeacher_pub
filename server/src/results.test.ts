import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendResults, lastDrillVerdicts, parseJsonl, readAllResults, type ResultRow } from "./results";

describe("results", () => {
  it("並行の保存が済んでから全履歴を読み、書き込みの順番を保つ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "english-review-"));
    try {
      const pending = Array.from({ length: 20 }, (_, i) => appendResults("test", [{
        kind: "drill", at: new Date().toISOString(), scene: "test", round: 1, ja: String(i), en: String(i), verdict: "wrong",
      }], dir));
      const rows = await readAllResults(dir);
      await Promise.all(pending);
      assert.equal(rows.length, 20);
      assert.deepEqual(rows.map((row) => row.kind === "drill" ? row.en : ""), Array.from({ length: 20 }, (_, i) => String(i)));
      assert.deepEqual(await readAllResults(dir), rows);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("JSONL を読み、壊れた行と知らない kind は飛ばす", () => {
    const text = [
      JSON.stringify({ kind: "drill", at: "t", scene: "s", round: 1, ja: "一", en: "one", verdict: "wrong" }),
      "{ broken",
      JSON.stringify({ kind: "other" }),
      "",
      JSON.stringify({ kind: "scene", at: "t", scene: "s", term: "one", status: "heard" }),
      JSON.stringify({ kind: "retell", at: "t", prompts: [], improvements: [], finished: true }),
    ].join("\n");
    const rows = parseJsonl(text);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.kind, "drill");
    assert.equal(rows[1]?.kind, "scene");
    assert.equal(rows[2]?.kind, "retell");
  });

  it("問題ごとの直近の判定を取る", () => {
    const rows: ResultRow[] = [
      { kind: "drill", at: "t", scene: "s", round: 1, ja: "一", en: "one", verdict: "wrong" },
      { kind: "drill", at: "t", scene: "s", round: 2, ja: "一", en: "one", verdict: "correct" },
      { kind: "drill", at: "t", scene: "s", round: 1, ja: "二", en: "two", verdict: "skipped" },
      { kind: "scene", at: "t", scene: "s", term: "two", status: "heard" },
    ];
    const last = lastDrillVerdicts(rows);
    assert.equal(last.get("one"), "correct");
    assert.equal(last.get("two"), "skipped");
    assert.equal(last.size, 2);
  });
});
