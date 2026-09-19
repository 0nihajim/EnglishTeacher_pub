/**
 * 先生の声を鳴らす。base64 PCM16 モノラル 24kHz を受けて、途切れないように
 * 並べて再生する。
 *
 * 元デモにこのファイルは無い。アバターの音声は LiveKit が運んで <audio> が
 * 鳴らしていたので、ブラウザは何もしなくてよかった。顔を捨てた代わりに、
 * 生の PCM を自分で並べる仕事がここに来ている。移植でいちばん増えた部分。
 *
 * 割り込みのときは flush() で捨てる。Gemini は割り込みを検知した時点で生成を
 * 破棄するので、こちらのキューに残っているのは「もう言わないことになった発話」。
 * 鳴らし切ると、先生の言っていないことが聞こえる。
 *
 * キューは長くなるのが正常。Gemini は1ターン分の音声を実時間より速く、数秒で
 * まとめて送ってくる(SDK の注釈: "generated as quickly as possible, and not in
 * real time")。十数秒の発話なら予約は十数秒先まで積み上がる。それを「溜まりすぎ」
 * と見て今へ寄せると、鳴っている途中の音声に次の音声が重なり、先生の声が二重に
 * 聞こえる(実際にそうなっていた)。前へ巻き戻してよいのは flush() だけ。
 */

/** Gemini の音声出力は常に 24kHz。 */
const OUTPUT_RATE = 24_000;

/**
 * 予約を現在時刻からこれだけ先に置く。ネットワークの揺れを吸収する余裕で、
 * 短すぎると細かく途切れ、長すぎると会話の反応が鈍く感じる。
 */
const JITTER_LEAD_S = 0.08;

export interface AudioPlayback {
  /** 受け取った音声を末尾に並べる。 */
  push: (base64Pcm24k: string) => void;
  /** 予約済みを全部捨てる(割り込み時)。 */
  flush: () => void;
  /** 予約が現在時刻より何秒先まで積まれているか。検証用(発話の長さに応じて伸びるのが正常)。 */
  queuedSeconds: () => number;
  /** 「いま鳴っている」の判定用。main.ts の光が使う。 */
  analyser: AnalyserNode;
  recordingStream: MediaStream;
  close: () => Promise<void>;
}

/**
 * 「はじめる」のタップの中で作っておいた AudioContext。
 *
 * iOS(iPhone の Chrome も WebKit)は、利用者の操作から離れた場所で呼んだ
 * resume() の約束を次の操作まで返さない。セッション開始の通信を待ってから
 * 音声を用意すると操作の効力が切れているので、ここで先に作って起こしておく。
 */
let primed: AudioContext | null = null;

/** 開始のタップの中から、待たずに呼ぶ。失敗しても黙って諦める(下で作り直す)。 */
export function primeAudioContext(): void {
  try {
    if (!primed || primed.state === "closed") {
      primed = new AudioContext({ sampleRate: OUTPUT_RATE });
    }
    void primed.resume();
  } catch {
    primed = null;
  }
}

export interface AudioPlaybackOptions {
  /**
   * 音声が止まっているあいだ true。iOS で操作の効力が切れていると、次のタップまで
   * 鳴らない。画面にそう出すために使う。
   */
  onLocked?: (locked: boolean) => void;
}

export async function createAudioPlayback(opts: AudioPlaybackOptions = {}): Promise<AudioPlayback> {
  // 出力レートを指定して作る。ブラウザ側の既定(48kHz)のままだと
  // AudioBuffer のレートと食い違い、再生が半分の速さになる。
  const ctx = primed && primed.state !== "closed" ? primed : new AudioContext({ sampleRate: OUTPUT_RATE });
  primed = null; // このセッションが引き取る

  // resume() は待たない。待つと、iOS では約束が返らないまま画面が
  // 「音声を準備中…」で止まる(実機で発生)。代わりに次の操作で起こし直す。
  let locked = false;
  const unlockEvents = ["pointerdown", "touchend", "keydown"] as const;
  const stopWaiting = () => {
    for (const type of unlockEvents) document.removeEventListener(type, unlock);
  };
  /** 鳴る状態になったら案内を下げる。statechange と resume() の両方から呼ぶ(どちらか一方に頼らない)。 */
  const settle = () => {
    if (!locked || ctx.state !== "running") return;
    locked = false;
    stopWaiting();
    opts.onLocked?.(false);
  };
  function unlock(): void {
    ctx.resume().then(settle, () => {
      /* まだ起こせない。次の操作で試す */
    });
  }
  ctx.addEventListener("statechange", settle);
  if (ctx.state !== "running") {
    locked = true;
    opts.onLocked?.(true);
    for (const type of unlockEvents) document.addEventListener(type, unlock, { passive: true });
    unlock();
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const recording = ctx.createMediaStreamDestination();
  analyser.connect(recording);

  let sources = new Set<AudioBufferSourceNode>();
  /** 次に鳴らす音声を置く時刻(ctx.currentTime 基準)。 */
  let nextAt = 0;

  const push = (base64: string): void => {
    const samples = pcm16FromBase64(base64);
    if (samples.length === 0) return;

    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channel[i] = (samples[i] ?? 0) / 0x8000;
    }

    const now = ctx.currentTime;
    // 予約が現在時刻より後ろに落ちていたら(最初の1つ、あるいは通信が途切れた)、
    // 少し先から並べ直す。積み上がっているときは触らない — それは遅れではなく、
    // まだ言い終えていない発話(ファイル冒頭を参照)。
    if (nextAt < now + JITTER_LEAD_S) nextAt = now + JITTER_LEAD_S;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    source.onended = () => {
      sources.delete(source);
    };
    sources.add(source);
    source.start(nextAt);
    nextAt += buffer.duration;
  };

  const flush = (): void => {
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* まだ start していない、あるいはもう終わっている */
      }
    }
    sources = new Set();
    nextAt = 0;
  };

  return {
    push,
    flush,
    queuedSeconds: () => Math.max(0, nextAt - ctx.currentTime),
    analyser,
    recordingStream: recording.stream,
    close: async () => {
      flush();
      stopWaiting();
      ctx.removeEventListener("statechange", settle);
      analyser.disconnect();
      recording.stream.getTracks().forEach(track => track.stop());
      await ctx.close();
    },
  };
}

/**
 * base64 → Int16Array。
 * PCM16 リトルエンディアン前提で、対象になる環境は全部リトルエンディアン。
 * 奇数バイトで終わっていたら最後の1バイトは捨てる(サンプルとして不完全)。
 */
function pcm16FromBase64(base64: string): Int16Array {
  const binary = atob(base64);
  const usable = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(usable);
  for (let i = 0; i < usable; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, usable / 2);
}
