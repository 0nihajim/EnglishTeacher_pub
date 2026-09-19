/**
 * 生存表示。表示は2つで rAF は1本。
 *  - マイクボタンの棒: キャプチャ経路の解析器から(送っている信号そのもの)。
 *  - 舞台の光(data-speaking): 再生経路の解析器から、先生が喋っているあいだ点く。
 *
 * どちらの解析器も後から差し込む。セッションの途中で付いたり外れたりするので、
 * 無いあいだは待機の棒だけ描く。
 */

export interface Liveness {
  /** rAF を回し始める。すでに回っていれば何もしない。 */
  start: () => void;
  /** rAF を止め、待機の棒を残し、光を消す。解析器も忘れる。 */
  stop: () => void;
  attachMic: (analyser: AnalyserNode) => void;
  attachVoice: (analyser: AnalyserNode) => void;
  /** ミュート中は棒を灰色に落とす(無音は解析器にも流れるが、色で即座に分かるように)。 */
  setMicMuted: (muted: boolean) => void;
}

const BAR_COUNT = 7;
const BINS_PER_BAR = 6; // fftSize 512 @ 48k → 約94Hz/bin: 7×6 bins ≈ 0〜4kHz(音声帯)
const BAR_W = 6;
/** 半秒の静けさを待ってから光を落とす。語の合間で点滅させない。 */
const GLOW_HOLD_MS = 500;
const SPEAKING_RMS = 0.02;

export function createLiveness(opts: {
  stage: HTMLElement;
  wave: HTMLCanvasElement;
  /** マイクの平均レベル(0〜1)を `--mic-level` として書き込む先。マイクボタンの輪が使う。 */
  level?: HTMLElement;
  /** 先生の声が鳴り始めた・止まった。番の表示(main.ts)が使う。 */
  onVoice?: (speaking: boolean) => void;
}): Liveness {
  const { stage, wave } = opts;
  const ctx = wave.getContext("2d") as CanvasRenderingContext2D;

  let micAnalyser: AnalyserNode | null = null;
  let micBuf: Uint8Array<ArrayBuffer> | null = null;
  let micMuted = false;
  let voiceAnalyser: AnalyserNode | null = null;
  let voiceBuf: Uint8Array<ArrayBuffer> | null = null;
  let quietSince = 0;
  let speaking = false;
  let raf = 0;

  const setSpeaking = (next: boolean) => {
    if (speaking === next) return;
    speaking = next;
    if (next) stage.dataset.speaking = "";
    else delete stage.dataset.speaking;
    opts.onVoice?.(next);
  };

  const drawBars = () => {
    const w = wave.width;
    const h = wave.height;
    ctx.clearRect(0, 0, w, h);
    const live = micAnalyser && micBuf && !micMuted;
    if (live) {
      micAnalyser!.getByteFrequencyData(micBuf!);
    }
    // ボタンの計算済みの色を使い、配色・ミュート・送信中の状態に揃える。
    ctx.fillStyle = getComputedStyle(wave).color;
    ctx.globalAlpha = live ? 1 : 0.55;
    const gap = (w - BAR_COUNT * BAR_W) / (BAR_COUNT - 1);
    let total = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      let level = 0;
      if (live) {
        let sum = 0;
        for (let j = 0; j < BINS_PER_BAR; j++) {
          sum += micBuf![1 + i * BINS_PER_BAR + j] ?? 0; // DC ビンを飛ばす
        }
        level = Math.min(1, (sum / BINS_PER_BAR / 255) * 1.4);
      }
      total += level;
      const barH = 6 + level * (h - 6);
      const x = i * (BAR_W + gap);
      ctx.beginPath();
      ctx.roundRect(x, (h - barH) / 2, BAR_W, barH, 3);
      ctx.fill();
    }
    opts.level?.style.setProperty("--mic-level", (total / BAR_COUNT).toFixed(3));
  };

  const updateGlow = (now: number) => {
    if (!voiceAnalyser || !voiceBuf) return;
    voiceAnalyser.getByteTimeDomainData(voiceBuf);
    let sum = 0;
    for (let i = 0; i < voiceBuf.length; i++) {
      const v = ((voiceBuf[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    if (Math.sqrt(sum / voiceBuf.length) > SPEAKING_RMS) {
      quietSince = 0;
      setSpeaking(true);
    } else {
      quietSince ||= now;
      if (now - quietSince > GLOW_HOLD_MS) setSpeaking(false);
    }
  };

  const tick = (now: number) => {
    drawBars();
    updateGlow(now);
    raf = requestAnimationFrame(tick);
  };

  drawBars(); // セッション前の待機の棒

  return {
    start() {
      raf ||= requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      micAnalyser = null;
      micBuf = null;
      micMuted = false;
      voiceAnalyser = null;
      voiceBuf = null;
      quietSince = 0;
      setSpeaking(false);
      opts.level?.style.removeProperty("--mic-level");
      drawBars(); // 喋っている最後のコマではなく、待機の棒を残す
    },
    attachMic(analyser) {
      micAnalyser = analyser;
      micBuf = new Uint8Array(analyser.frequencyBinCount);
    },
    attachVoice(analyser) {
      voiceAnalyser = analyser;
      voiceBuf = new Uint8Array(analyser.fftSize);
    },
    setMicMuted(muted) {
      micMuted = muted;
    },
  };
}
