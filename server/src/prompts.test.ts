import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageDirective, languageName } from "./prompts";

describe("languageName", () => {
  it("BCP-47 の主言語部分で名前を引く", () => {
    assert.equal(languageName("en-US"), "English");
    assert.equal(languageName("ja-JP"), "Japanese");
    assert.equal(languageName("ja"), "Japanese");
    assert.equal(languageName("EN_GB"), "English");
  });

  it("知らないコードはそのまま", () => {
    assert.equal(languageName("tlh"), "tlh");
  });
});

describe("languageDirective", () => {
  it("空なら何も付けない(自動判定)", () => {
    assert.equal(languageDirective([]), "");
  });

  it("2言語は and でつなぎ、他の言語を聞かないよう指示する", () => {
    const text = languageDirective(["en-US", "ja-JP"]);
    assert.match(text, /^\n\n/);
    assert.match(text, /speaks only English and Japanese\./);
    assert.match(text, /never a third language/);
    assert.match(text, /You too speak only English and Japanese\./);
  });

  it("1言語なら that language、地域違いの同じ言語は1つに数える", () => {
    const text = languageDirective(["en-US", "en-GB"]);
    assert.match(text, /speaks only English\. Whatever they say is that language/);
  });

  it("3言語以上はカンマと and", () => {
    assert.match(languageDirective(["en", "ja", "ko"]), /English, Japanese, and Korean/);
  });
});
