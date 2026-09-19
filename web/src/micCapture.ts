/**
 * マイク → base64 PCM16 モノラル 16kHz、AudioWorklet 経由。
 *
 * 元デモ(MIT © 2026 HeyGen)の web/src/micCapture.ts をほぼそのまま使っている。
 * 変えたのは2点。出力レートは GPT-Live の 24kHz に対し Gemini Live の入力は
 * 16kHz(他のレートでも再サンプリングしてくれるが、素の 16kHz を送るほうが帯域も
 * 上流の手間も少ない)。送信の粒度は、ワークレットの1ブロック(128 フレーム ≈ 2.7ms)
 * ごとではなく 50ms ぶんまとめる。そうしないと毎秒 375 本のメッセージが
 * ブラウザ→サーバー→Gemini の両区間に流れる。
 *
 * VAD は意図的に入れていない。Gemini は全二重で、会話の文脈ごと同じ音声を
 * 聞いて自分で発話の切れ目を決める。ブラウザは入出力だけを担う。
 * ダウンサンプルを音声スレッドでやるのは、メインスレッドだと描画のたびに
 * フレームを落とすから。
 */

const TARGET_SAMPLE_RATE = 16_000;
/** これだけ溜めてから1メッセージにする。 */
const BATCH_MS = 50;

const WORKLET_CODE = `
class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.batchSamples = opts.batchSamples || 800;
    this.ratio = sampleRate / this.targetRate;
    this.pos = 0;
    this.pending = [];
    this.port.onmessage = (e) => { if (e.data === 'flush') this.onFlushRequest(); };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const start = Math.floor(this.pos);
      const end = Math.min(ch.length, Math.ceil(this.pos + this.ratio));
      let sum = 0, cnt = 0;
      for (let j = start; j < end; j++) { sum += ch[j]; cnt++; }
      this.pending.push(cnt ? sum / cnt : (ch[start] || 0));
    }
    this.pos -= ch.length;
    if (this.pending.length >= this.batchSamples) this.flush();
    return true;
  }
  /** メインスレッドからの 'flush': 溜まっている分を出し切り、'flushed' で答える。 */
  onFlushRequest() {
    if (this.pending.length > 0) this.flush();
    this.port.postMessage('flushed');
  }
  flush() {
    const out = this.pending;
    this.pending = [];
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) {
      let s = Math.max(-1, Math.min(1, out[k]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}
registerProcessor('pcm-downsampler', PCMDownsampler);
`;

export interface MicCapture {
  stream: MediaStream;
  stop: () => void;
  /**
   * ミュートはキャプチャを止めるのではなくトラックを無効にする。無効なトラックは
   * 無音を出すので、ワークレットはフレームを送り続け、上流は途切れない無音を聞く。
   * 発話の切れ目の判断はモデルに残る。
   */
  setMuted: (muted: boolean) => void;
  /**
   * 50ms のまとめ待ちに溜まっている音声を、いま出し切る。resolve した時点で、
   * その分の onAudio は呼び終わっている。手動の区切りで「送信」を押したとき、
   * 発話の末尾を「言い終えた」の合図より先に届けるために使う。
   */
  flush: () => Promise<void>;
  /**
   * ワークレットが食べているのと同じ音源を覗く。UI 用(マイクボタンの棒)。
   * ミュートすると自然に平らになる — 無効なトラックはここにも無音を流す。
   */
  analyser: AnalyserNode;
}

export async function startMicCapture(
  onAudio: (base64Pcm16k: string) => void,
): Promise<MicCapture> {
  // エコーキャンセルはここでは普段以上に効く。先生の声は同じ機械のスピーカーから
  // 出ていて、これが無いとモデルが自分の声を聞いて自分に答え始める。
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const audioContext = new AudioContext();
  // Chrome はユーザー操作の呼び出し中に作られたコンテキスト以外を suspended で
  // 始める。ここは await getUserMedia の後なので既に操作のスタックを離れている。
  // resume しないとワークレットが回らない: フレームも来ずエラーも出ず、
  // ただ聞こえない先生になる。
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await audioContext.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "pcm-downsampler", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      targetRate: TARGET_SAMPLE_RATE,
      batchSamples: (TARGET_SAMPLE_RATE * BATCH_MS) / 1000,
    },
  });

  // flush() の待ち手。ワークレットは音声を先に、'flushed' を後に送る(MessagePort は
  // 順序を守る)ので、'flushed' が届いた時点で直前までの音声は onAudio を通っている。
  let flushWaiters: (() => void)[] = [];
  const settleFlushes = () => {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) resolve();
  };

  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer | "flushed">) => {
    if (e.data === "flushed") {
      settleFlushes();
      return;
    }
    const bytes = new Uint8Array(e.data);
    if (bytes.length === 0) return;
    onAudio(base64FromBytes(bytes));
  };

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  source.connect(worklet);
  // ワークレットは destination に繋がっている間しか回らないが、その出力は生の
  // マイクそのもの。音量0のゲインを通すことで、自分の声を自分に聞かせずに回す。
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  worklet.connect(mute);
  mute.connect(audioContext.destination);

  return {
    stream,
    analyser,
    setMuted: (muted) => {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    flush: () =>
      new Promise<void>((resolve) => {
        flushWaiters.push(resolve);
        worklet.port.postMessage("flush");
      }),
    stop: () => {
      worklet.port.onmessage = null;
      // 止めた後に 'flushed' は来ない。待っている送信を放置しない。
      settleFlushes();
      worklet.disconnect();
      mute.disconnect();
      analyser.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void audioContext.close();
    },
  };
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
