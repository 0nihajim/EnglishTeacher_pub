import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLanguages } from "./config";

describe("parseLanguages", () => {
  it("カンマ区切りを配列にする", () => {
    assert.deepEqual(parseLanguages("en-US,ja-JP"), ["en-US", "ja-JP"]);
  });

  it("空白と空要素と重複を落とす", () => {
    assert.deepEqual(parseLanguages(" en-US , ja-JP,, en-US "), ["en-US", "ja-JP"]);
    assert.deepEqual(parseLanguages("en ja"), ["en", "ja"]);
  });

  it("空文字は [](自動判定に任せる)", () => {
    assert.deepEqual(parseLanguages(""), []);
    assert.deepEqual(parseLanguages("  ,  "), []);
  });
});
