export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_RECORDING_BYTES = 32_000_000;
export const UPLOAD_GRACE_MS = 10 * 60 * 1000;

export function recordingExpiresAt(endedAt: number): number {
  if (!Number.isFinite(endedAt) || endedAt < 0) throw new Error("Invalid recording end time");
  return endedAt + RETENTION_MS;
}

/** 未完了アップロードと削除待ちも used/reserved に含めて判定する。 */
export function recordingAdmission(
  used: number, reserved: number, budget: number, paused: boolean,
): { allowed: boolean; paused: boolean } {
  if (![used, reserved, budget].every(Number.isFinite) || used < 0 || reserved < 0 || budget <= 0) {
    return { allowed: false, paused: true };
  }
  const total = used + reserved;
  const fits = total + MAX_RECORDING_BYTES <= budget * 0.8;
  const nextPaused = !fits || (paused && total >= budget * 0.7);
  return { allowed: !nextPaused, paused: nextPaused };
}

export function compressedAudioType(header: string | null, bytes: Uint8Array): string | null {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  if (type === "audio/webm" && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (type === "audio/ogg" && new TextDecoder().decode(bytes.slice(0, 4)) === "OggS") return "audio/ogg";
  if (type === "audio/mp4" && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp") return "audio/mp4";
  return null;
}
