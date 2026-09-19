/**
 * 学習者の発話の録音(話し直しの「録音比較」)。
 *
 * 「話す」から「送信」までのマイク音声 — サーバーへ送っているのと同じ base64 PCM16 16kHz の
 * フレーム — を札(1回目 = first、2回目 = second)ごとに溜め、比較のカードから鳴らす。
 * サーバーには送らず、セッションが終わると消える。1分で約 1.9MB。
 *
 * 鳴らすときは 16kHz の AudioBuffer を作る。再生用の AudioContext(48kHz が普通)が
 * 再サンプルするので、レートを合わせる必要は無い。
 */
import type { TakePlayer } from "./overlays/retell";

const SAMPLE_RATE = 16_000;

export interface TakeStore extends TakePlayer {
  /** 「話す」。この札に録り始める。 */
  begin(label: string): void;
  /** マイクの1フレーム。begin と end の間だけ溜まる。 */
  push(base64: string): void;
  /** 「送信」。 */
  end(): void;
  /** 全部消す(セッションの終わり)。鳴っていれば止める。 */
  clear(): void;
}

export function createTakeStore(): TakeStore {
  const takes = new Map<string, Uint8Array[]>();
  let current: string | null = null;
  let ctx: AudioContext | null = null;
  let playing: { source: AudioBufferSourceNode; onState: (playing: boolean) => void } | null = null;

  const stop = () => {
    const now = playing;
    playing = null;
    if (!now) return;
    now.source.onended = null;
    try {
      now.source.stop();
    } catch {
      /* もう終わっている */
    }
    now.onState(false);
  };

  return {
    begin(label) {
      current = label;
      takes.set(label, []);
    },
    push(base64) {
      if (current === null) return;
      takes.get(current)?.push(bytesFromBase64(base64));
    },
    end() {
      current = null;
    },
    has(label) {
      return (takes.get(label)?.length ?? 0) > 0;
    },
    play(label, onState) {
      stop();
      const chunks = takes.get(label);
      if (!chunks || chunks.length === 0) return;
      ctx ??= new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
      const samples = concatPcm16(chunks);
      const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] ?? 0) / 0x8000;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (playing?.source === source) playing = null;
        onState(false);
      };
      playing = { source, onState };
      onState(true);
      source.start();
    },
    stop,
    clear() {
      stop();
      takes.clear();
      current = null;
    },
  };
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 断片を1本にして Int16 で読む(リトルエンディアン。奇数バイトの端は捨てる)。 */
function concatPcm16(chunks: readonly Uint8Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const usable = total - (total % 2);
  const all = new Uint8Array(usable);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, usable - offset);
    if (take <= 0) break;
    all.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new Int16Array(all.buffer, 0, usable / 2);
}
