import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compressedAudioType, MAX_RECORDING_BYTES, recordingAdmission, recordingExpiresAt } from "./recording-policy";

describe("recording retention and admission", () => {
  it("録音終了から14日で期限になる", () => {
    assert.equal(recordingExpiresAt(Date.parse("2026-09-18T12:34:56Z")), Date.parse("2026-10-02T12:34:56Z"));
    assert.throws(() => recordingExpiresAt(NaN));
  });
  it("進行中アップロードを含め80%で停止し、70%を下回るまで再開しない", () => {
    const budget = 8_000_000_000;
    assert.equal(recordingAdmission(0, 0, budget, false).allowed, true);
    assert.equal(recordingAdmission(budget * .8 - MAX_RECORDING_BYTES, MAX_RECORDING_BYTES, budget, false).allowed, false);
    assert.deepEqual(recordingAdmission(budget * .7, 0, budget, true), { allowed: false, paused: true });
    assert.deepEqual(recordingAdmission(budget * .69, 0, budget, true), { allowed: true, paused: false });
    assert.equal(recordingAdmission(0, 0, NaN, false).allowed, false);
  });
  it("予算より予約が大きければ再開しない", () => {
    assert.deepEqual(recordingAdmission(69, 0, 100, true), { allowed: false, paused: true });
  });
  it("圧縮音声の種類と先頭バイトを検証し、無圧縮WAVは受け入れない", () => {
    assert.equal(compressedAudioType("audio/webm;codecs=opus", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), "audio/webm");
    assert.equal(compressedAudioType("audio/mp4", new TextEncoder().encode("0000ftyp")), "audio/mp4");
    assert.equal(compressedAudioType("audio/ogg", new TextEncoder().encode("OggS")), "audio/ogg");
    assert.equal(compressedAudioType("audio/webm", new TextEncoder().encode("RIFF")), null);
    assert.equal(compressedAudioType("audio/wav", new TextEncoder().encode("RIFF")), null);
  });
});
