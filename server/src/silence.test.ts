import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pcm16DurationMs, SilenceWatch } from "./silence";

/** n バイトぶんの base64(中身はゼロ)。 */
const bytesB64 = (n: number) => Buffer.alloc(n).toString("base64");

describe("pcm16DurationMs", () => {
  it("24kHz PCM16 の 48,000 バイトは 1,000ms", () => {
    assert.equal(pcm16DurationMs(bytesB64(48_000)), 1_000);
  });

  it("base64 のパディングを数に入れない", () => {
    assert.equal(pcm16DurationMs(bytesB64(48)), 1); // パディングなし
    assert.equal(pcm16DurationMs(bytesB64(96)), 2);
    assert.equal(pcm16DurationMs(bytesB64(50)), 25 / 24); // "=" 1つ
    assert.equal(pcm16DurationMs(bytesB64(52)), 26 / 24); // "==" 2つ
  });

  it("奇数バイトの端はサンプルとして数えない", () => {
    assert.equal(pcm16DurationMs(bytesB64(49)), 1);
  });

  it("空なら 0", () => {
    assert.equal(pcm16DurationMs(""), 0);
  });
});

describe("SilenceWatch", () => {
  const idle = { generating: false, userTurnOpen: false };
  const make = () => {
    const w = new SilenceWatch(15_000, 20_000);
    w.start(0);
    return w;
  };

  it("バーストで届いた音声は再生終了の予定から数える", () => {
    const w = make();
    // 6秒ぶんの音声が 0〜2 秒の間に届く。再生は 80ms + 6s = 6,080ms に終わる予定。
    w.noteAudio(2_000, 0);
    w.noteAudio(2_000, 1_000);
    w.noteAudio(2_000, 2_000);
    assert.equal(w.playbackEndsAt, 6_080);
    // 受信が終わった 2 秒から 15 秒後では、まだ黙ってから 15 秒経っていない
    assert.equal(w.shouldCheckin(17_000, idle), false);
    assert.equal(w.shouldCheckin(6_080 + 14_999, idle), false);
    assert.equal(w.shouldCheckin(6_080 + 15_000, idle), true);
  });

  it("生成中・学習者のターンが開いている間・再生中は頼まない", () => {
    const w = make();
    assert.equal(w.shouldCheckin(30_000, { generating: true, userTurnOpen: false }), false);
    assert.equal(w.shouldCheckin(30_000, { generating: false, userTurnOpen: true }), false);
    w.noteAudio(10_000, 30_000);
    assert.equal(w.shouldCheckin(35_000, idle), false); // まだ鳴っている
  });

  it("turnComplete と学習者の活動も起点になる", () => {
    const w = make();
    w.noteTurnComplete(10_000);
    assert.equal(w.shouldCheckin(24_999, idle), false);
    w.noteUserActivity(20_000);
    assert.equal(w.shouldCheckin(34_999, idle), false);
    assert.equal(w.shouldCheckin(35_000, idle), true);
  });

  it("割り込みで再生終了の予定は今に戻る", () => {
    const w = make();
    w.noteAudio(30_000, 0); // 30 秒ぶん積まれていたが
    w.noteInterrupted(5_000); // 5 秒で捨てられた
    assert.equal(w.playbackEndsAt, 5_000);
    assert.equal(w.shouldCheckin(19_999, idle), false);
    assert.equal(w.shouldCheckin(20_000, idle), true);
  });

  it("一度頼んだらクールダウンのあいだは頼まない", () => {
    const w = make();
    assert.equal(w.shouldCheckin(15_000, idle), true);
    assert.equal(w.shouldCheckin(34_999, idle), false);
    assert.equal(w.shouldCheckin(35_000, idle), true);
  });

  it("開始前の沈黙は数えない", () => {
    const w = new SilenceWatch(15_000, 20_000);
    w.start(100_000);
    assert.equal(w.shouldCheckin(114_999, idle), false);
    assert.equal(w.shouldCheckin(115_000, idle), true);
  });
});
