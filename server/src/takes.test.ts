import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pcm16InputDurationMs, TakeRecorder, wavFromPcm16 } from "./takes";

/** n ms ぶんの 16kHz PCM16(中身はゼロ)を base64 で。 */
const msB64 = (ms: number) => Buffer.alloc(ms * 32).toString("base64");

describe("pcm16InputDurationMs", () => {
  it("16kHz PCM16 の 32,000 バイトは 1,000ms。奇数バイトの端は数えない", () => {
    assert.equal(pcm16InputDurationMs(32_000), 1_000);
    assert.equal(pcm16InputDurationMs(33), 1);
    assert.equal(pcm16InputDurationMs(0), 0);
  });
});

describe("TakeRecorder", () => {
  it("「話す」から「送信」までの音声を1本にする。外の音声は捨てる", () => {
    const rec = new TakeRecorder();
    rec.push(msB64(100)); // まだ開いていない
    assert.equal(rec.open, false);
    rec.begin(1_000);
    rec.begin(1_500); // 二度押しは無視
    rec.push(msB64(50));
    rec.push(msB64(50));
    const take = rec.end(2_000);
    assert.ok(take);
    assert.equal(take.durationMs, 100);
    assert.equal(take.pcm.length, 3_200);
    assert.equal(take.startedAt, 1_000);
    assert.equal(take.endedAt, 2_000);
    assert.equal(take.truncated, false);
    assert.equal(rec.open, false);
    assert.equal(rec.end(2_100), null); // 閉じているときの送信
    rec.push(msB64(50)); // 閉じた後は捨てる
    rec.begin(3_000);
    assert.equal(rec.end(3_100)?.durationMs, 0);
  });

  it("上限を超えた分は捨て、truncated を立てる", () => {
    const rec = new TakeRecorder(10);
    rec.begin(0);
    rec.push(msB64(8));
    rec.push(msB64(8)); // 2ms ぶんだけ入る
    rec.push(msB64(8)); // 全部捨てる
    const take = rec.end(100);
    assert.equal(take?.durationMs, 10);
    assert.equal(take?.pcm.length, 320);
    assert.equal(take?.truncated, true);
  });
});

describe("wavFromPcm16", () => {
  it("44 バイトの RIFF/WAVE ヘッダを付ける(モノラル 16bit 16kHz)", () => {
    const pcm = Buffer.alloc(3_200);
    const wav = wavFromPcm16(pcm);
    assert.equal(wav.length, 44 + 3_200);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), 36 + 3_200);
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.toString("ascii", 12, 16), "fmt ");
    assert.equal(wav.readUInt32LE(16), 16);
    assert.equal(wav.readUInt16LE(20), 1); // PCM
    assert.equal(wav.readUInt16LE(22), 1); // モノラル
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt32LE(28), 32_000); // バイト/秒
    assert.equal(wav.readUInt16LE(32), 2); // ブロック
    assert.equal(wav.readUInt16LE(34), 16); // ビット
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), 3_200);
    assert.equal(wav.subarray(44).equals(pcm), true);
  });
});
