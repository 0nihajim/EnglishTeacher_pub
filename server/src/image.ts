/**
 * 学習者が選んだ画像(話し直しトレーニング)。POST /api/session/start の body で届く。
 *
 * 値はブラウザから来るので信用しない。種類は宣言(mime_type)ではなく中身の先頭バイトで
 * 決め、base64 の文字種と大きさをここで検査する。通ったものだけが Gemini に渡る。
 * ブラウザは長辺 1280px 以下に縮めて送ってくるので、通常は 1MB 前後で収まる。
 */

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface LearnerImage {
  mimeType: ImageMime;
  /** base64。 */
  data: string;
  /** デコード後のバイト数(ログと上限の判定に)。 */
  bytes: number;
}

/** これより大きい画像は断る。Gemini のインライン上限(20MB)よりずっと手前で止める。 */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export class ImageError extends Error {}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** base64 の長さからデコード後のバイト数を出す(デコードせずに)。 */
export function base64Bytes(b64: string): number {
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** 先頭バイトから画像の種類を決める。知らない並びなら undefined。 */
export function sniffImage(head: Uint8Array): ImageMime | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && // R
    head[1] === 0x49 && // I
    head[2] === 0x46 && // F
    head[3] === 0x46 && // F
    head[8] === 0x57 && // W
    head[9] === 0x45 && // E
    head[10] === 0x42 && // B
    head[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return undefined;
}

/** body の image を検査して LearnerImage に。壊れていれば ImageError(理由は学習者に見せる文)。 */
export function parseLearnerImage(raw: unknown): LearnerImage {
  if (!isRecord(raw)) throw new ImageError("画像が付いていません — 写真かスクリーンショットを1枚選んでください");
  return parseImage(raw.data, MAX_IMAGE_BYTES, "6MB");
}

/**
 * ボードの1フレームはこれより大きければ捨てる。長辺 768px の白地 JPEG は 30〜100KB なので、
 * 1MB を超えるのはブラウザが縮めていないか、別のものを送っている。
 */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024;

/**
 * board_frame メッセージの中身を検査する(ボード)。上限が違うだけで検査は画像と同じ。
 * 壊れていれば ImageError。フレームは学習者に見せる失敗ではないので、呼ぶ側はログに出して捨てる。
 */
export function parseBoardFrame(raw: unknown): LearnerImage {
  if (!isRecord(raw)) throw new ImageError("フレームの形が違う");
  return parseImage(raw.data, MAX_FRAME_BYTES, "1MB");
}

function parseImage(data: unknown, maxBytes: number, maxLabel: string): LearnerImage {
  if (typeof data !== "string" || data.length === 0) throw new ImageError("画像のデータが空です");
  const bytes = base64Bytes(data);
  if (bytes > maxBytes) {
    throw new ImageError(`画像が大きすぎます(${(bytes / 1024 / 1024).toFixed(1)}MB)— ${maxLabel} 以下にしてください`);
  }
  if (!BASE64.test(data)) throw new ImageError("画像のデータが base64 ではありません");
  // 先頭だけデコードして種類を見る。宣言された mime_type は使わない(嘘をつける)。
  const head = Buffer.from(data.slice(0, 24), "base64");
  const mimeType = sniffImage(head);
  if (!mimeType) throw new ImageError("JPEG・PNG・WebP のどれかにしてください");
  return { mimeType, data, bytes };
}
