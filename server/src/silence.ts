/**
 * 無音の見張り(純粋ロジック)。
 *
 * 「誰も何も言っていない」を判定するのに、先生の音声の受信時刻は使えない。
 * Gemini は1ターン分の音声を実時間より速く一気に送るので、最後のチャンクを
 * 受け取った時点でブラウザはまだ何秒も喋り続けている。以前はここを受信時刻で
 * 数えていたため、先生が喋り終わるずっと前からカウントが始まり、学習者が口を
 * 開く直前に「声かけ」の指示が飛んでいた。
 *
 * ここでは届いた PCM の長さを積み上げて「再生が終わる予定時刻」を持ち、
 * そこを起点に数える。時刻は全部引数で受け取る(テストで時計を差し替えるため)。
 */

/** 先生の音声は PCM16 モノラル 24kHz。1ms = 24 サンプル = 48 バイト。 */
const OUTPUT_SAMPLES_PER_MS = 24;

/** ブラウザ側の予約の先出し(audioPlayback.ts の JITTER_LEAD_S)と揃える。 */
const PLAYBACK_LEAD_MS = 80;

/** 誰も何も言わない時間がこれを超えたら、先生に声をかけさせる。 */
export const SILENCE_CHECKIN_MS = 15_000;
/** 声かけの間隔の下限。これが無いと閾値を超えている間ずっと催促し続ける。 */
export const CHECKIN_COOLDOWN_MS = 20_000;

/**
 * base64 の PCM16 24kHz が何 ms ぶんか。デコードせず長さから求める。
 * 奇数バイトで終わっていたら最後の1バイトはサンプルとして数えない。
 */
export function pcm16DurationMs(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return Math.floor(bytes / 2) / OUTPUT_SAMPLES_PER_MS;
}

export interface SilenceState {
  /** モデルが生成中。喋っている最中に声かけを頼むと生成に割り込む。 */
  generating: boolean;
  /** 学習者の字幕の行が開いている = 話している途中。 */
  userTurnOpen: boolean;
}

export class SilenceWatch {
  private startedAt = 0;
  /** 届いた音声を全部鳴らし終える予定の時刻。 */
  private playbackEndAt = 0;
  private lastTurnCompleteAt = 0;
  private lastUserActivityAt = 0;
  private lastCheckinAt = 0;

  constructor(
    private readonly checkinMs: number = SILENCE_CHECKIN_MS,
    private readonly cooldownMs: number = CHECKIN_COOLDOWN_MS,
  ) {}

  /** 見張りの起点。挨拶が来る前の沈黙を「無音」と数えない。 */
  start(now: number): void {
    this.startedAt = now;
  }

  /** 先生の音声が届いた。ブラウザは末尾に並べるので、終了予定はその分だけ後ろへ。 */
  noteAudio(durationMs: number, now: number): void {
    this.playbackEndAt = Math.max(this.playbackEndAt, now + PLAYBACK_LEAD_MS) + durationMs;
  }

  /** モデルのターンが閉じた。SDK 上これは再生終了の見込みまで待って届く。 */
  noteTurnComplete(now: number): void {
    this.lastTurnCompleteAt = now;
  }

  /** 学習者が割り込んだ。ブラウザは再生待ちを捨てるので、再生はいま終わる。 */
  noteInterrupted(now: number): void {
    this.playbackEndAt = now;
  }

  /** 学習者の声(文字起こしの断片、または暫定の文字起こし)。 */
  noteUserActivity(now: number): void {
    this.lastUserActivityAt = now;
  }

  /** 再生終了の予定(ログ用)。 */
  get playbackEndsAt(): number {
    return this.playbackEndAt;
  }

  /** いま声かけを頼むべきか。true を返したときは同時にクールダウンが始まる。 */
  shouldCheckin(now: number, state: SilenceState): boolean {
    if (state.generating || state.userTurnOpen) return false;
    if (now < this.playbackEndAt) return false;
    if (now - this.lastSignal() < this.checkinMs) return false;
    if (this.lastCheckinAt !== 0 && now - this.lastCheckinAt < this.cooldownMs) return false;
    this.lastCheckinAt = now;
    return true;
  }

  /** ログ用の内訳。 */
  describe(now: number): string {
    const ago = (at: number) => (at === 0 ? "なし" : `${Math.round((now - at) / 1000)}秒前`);
    return (
      `先生の再生終了 ${ago(this.playbackEndAt)}, turnComplete ${ago(this.lastTurnCompleteAt)}, ` +
      `学習者 ${ago(this.lastUserActivityAt)}`
    );
  }

  private lastSignal(): number {
    return Math.max(this.startedAt, this.playbackEndAt, this.lastTurnCompleteAt, this.lastUserActivityAt);
  }
}
