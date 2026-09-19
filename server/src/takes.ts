/**
 * 学習者の発話1回分(テイク)の録音。話し直しトレーニングで、「話す」から「送信」までの
 * マイク音声を溜めておき、Flash に聞かせる。
 *
 * マイク音声は base64 の PCM16 モノラル 16kHz で届く(web/src/micCapture.ts)。ここでは
 * デコードして並べるだけで、Flash に渡すときに WAV のヘッダを付ける(wavFromPcm16)。
 * Gemini の generateContent は audio/wav を受け付け、素の PCM は受け付けない。
 *
 * 長さの上限を持つ。3分を超えた分は捨て、truncated を立てる。1リクエスト 20MB の
 * 上限に対して 3分 = 5.8MB(base64 で 7.7MB)なので、画像と合わせても収まる。
 */

/** マイクの PCM16 16kHz: 1ms = 16 サンプル = 32 バイト。 */
const INPUT_BYTES_PER_MS = 32;
export const INPUT_SAMPLE_RATE = 16_000;

export const MAX_TAKE_MS = 3 * 60_000;

export interface Take {
  /** PCM16 モノラル 16kHz。 */
  pcm: Buffer;
  /** 音声の長さ(PCM のバイト数から)。ボタンの間隔ではなく、届いた音の量。 */
  durationMs: number;
  startedAt: number;
  endedAt: number;
  /** 上限を超えて末尾を捨てた。 */
  truncated: boolean;
}

export function pcm16InputDurationMs(bytes: number): number {
  return Math.floor(bytes / 2) * 2 / INPUT_BYTES_PER_MS;
}

export class TakeRecorder {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private startedAt: number | null = null;
  private truncated = false;

  constructor(private readonly maxMs: number = MAX_TAKE_MS) {}

  get open(): boolean {
    return this.startedAt !== null;
  }

  /** 「話す」。すでに開いていれば何もしない(二度押し)。 */
  begin(now: number): void {
    if (this.startedAt !== null) return;
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
    this.startedAt = now;
  }

  /** マイクの1フレーム。開いていないときは捨てる。 */
  push(audioB64: string): void {
    if (this.startedAt === null) return;
    const maxBytes = this.maxMs * INPUT_BYTES_PER_MS;
    if (this.bytes >= maxBytes) {
      this.truncated = true;
      return;
    }
    let chunk = Buffer.from(audioB64, "base64");
    if (this.bytes + chunk.length > maxBytes) {
      chunk = chunk.subarray(0, maxBytes - this.bytes);
      this.truncated = true;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  /** 「送信」。開いていなければ null。 */
  end(now: number): Take | null {
    if (this.startedAt === null) return null;
    const pcm = Buffer.concat(this.chunks, this.bytes);
    const take: Take = {
      pcm,
      durationMs: pcm16InputDurationMs(pcm.length),
      startedAt: this.startedAt,
      endedAt: now,
      truncated: this.truncated,
    };
    this.chunks = [];
    this.bytes = 0;
    this.startedAt = null;
    this.truncated = false;
    return take;
  }
}

/** PCM16 モノラルに 44 バイトの RIFF/WAVE ヘッダを付ける。 */
export function wavFromPcm16(pcm: Buffer, sampleRate: number = INPUT_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bytesPerSample = 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt チャンクの長さ
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
