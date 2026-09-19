/**
 * セッション1つ分の配線。上流の Gemini の脚と、ブラウザのソケット1本を持ち、
 * モードの方針(modes/ のコーチ)と文字起こしの組み立て(turns.ts)、無音の見張り
 * (silence.ts)をつなぐ。
 *
 * 元デモの session.ts から消えたもの:
 *  - メディアサーバーの脚(アバターがない)。
 *  - 割り込み判定の推測機構。デモは「相槌」と「本当の割り込み」を区別するために
 *    600ms 見張って音声の途切れ具合で決めていた。Gemini は serverContent.interrupted
 *    を明示的に送るので、こちらは受けて流すだけ。
 *
 * ここに残っているのは配線だけ。何を教えるか・どう進めるかは SessionPlan
 * (modes/index.ts)が決め、ここはそれを Gemini とブラウザにつなぐ。
 */

import type { ControlAction, ServerMessage, Turn, TurnTaking } from "../../shared/messages";
import { FramePacer } from "../../shared/strokes";
import { GeminiLiveBridge, type GeminiEvents, type ToolReply } from "./gemini";
import { ImageError, parseBoardFrame, type LearnerImage } from "./image";
import type { Coach, SessionPlan } from "./modes/types";
import type { CoachCheckpoint } from "./modes/checkpoint";
import { MANUAL_TURN_DIRECTIVE, SILENCE_CHECKIN } from "./prompts";
import { pcm16DurationMs, SilenceWatch } from "./silence";
import { TakeRecorder } from "./takes";
import { TurnProjector } from "./turns";

const SILENCE_POLL_MS = 3_000;
/** 板のフレームは上流に1枚/秒まで。ブラウザも同じ上限で送るが、ここでも守る(信用しない)。 */
const FRAME_MIN_INTERVAL_MS = 1_000;
export type SessionBridge = Pick<GeminiLiveBridge,
  "start" | "close" | "sendMicAudio" | "endMicStream" | "startActivity" | "endActivity" | "nudge" | "sendVideoFrame" | "generating" | "activityOpen">;

export interface FrontendSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SessionObserver {
  /** 確定した発話と UI を保存する。音声フレームの永続化は別の経路で扱う。 */
  onMessage?(message: ServerMessage): void;
}

export interface SessionCheckpoint {
  version: 1;
  turnSequence: number;
  coach: CoachCheckpoint;
}

export class Session implements GeminiEvents {
  private readonly bridge: SessionBridge;
  private readonly turns: TurnProjector;
  private readonly coach: Coach;
  private readonly silence = new SilenceWatch();
  /** 「話す」から「送信」までの録音。コーチが録音を要るとき(話し直し)だけ持つ。 */
  private readonly recorder: TakeRecorder | null;

  private frontend: FrontendSocket | null = null;
  private started = false;
  private ready = false;
  private stopping = false;
  /** 字幕のないツールだけの応答も、先生の1ターンとして閉じる。 */
  private teacherTurnActive = false;

  /** マイクのフレームで更新する。放置セッションを刈る唯一の生存信号。 */
  lastActivityAt = Date.now();

  private silencePoll: NodeJS.Timeout | null = null;

  /** ボード: 板のフレームの間引き。間隔内に複数来たら最後の1枚を遅らせて送る。 */
  private readonly framePacer = new FramePacer({ settleMs: 0, minIntervalMs: FRAME_MIN_INTERVAL_MS });
  private pendingFrame: { frame: LearnerImage; seq: number } | null = null;
  private frameTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly sessionId: string,
    readonly plan: SessionPlan,
    /** 学習者の発話の区切り。接続時に決まり、途中では変えられない。 */
    readonly turnTaking: TurnTaking,
    /** 脚が死んでセッションが成立しなくなったときに呼ぶ。 */
    private readonly onDead: (sessionId: string) => void,
    bridgeFactory: (...args: ConstructorParameters<typeof GeminiLiveBridge>) => SessionBridge =
      (...args) => new GeminiLiveBridge(...args),
    private readonly observer: SessionObserver = {},
    checkpoint?: SessionCheckpoint,
  ) {
    this.turns = new TurnProjector({ onTurn: (turn) => this.handleTurn(turn) });
    this.recorder = plan.captureSpeech ? new TakeRecorder() : null;
    this.coach = plan.coach({
      showUi: (ui) => this.emit({ type: "ui", ...ui }),
      nudge: (text, mode) => this.bridge.nudge(text, mode),
      log: (msg) => this.log(msg),
      teacherSpeaking: () => this.bridge.generating,
    });
    if (checkpoint) {
      if (checkpoint.version !== 1 || !this.coach.restore?.(checkpoint.coach)) throw new Error("セッションの状態を復元できません");
      this.turns.restoreSequence(checkpoint.turnSequence);
    }
    const bridgeOptions: ConstructorParameters<typeof GeminiLiveBridge>[1] = {
      // 手動の区切りでは、学習者の声が「送信」まで届かないことを先生に教える。
      systemInstruction: plan.systemInstruction + (turnTaking === "manual" ? MANUAL_TURN_DIRECTIVE : ""),
      greeting: checkpoint ? "接続が再開した。新しいレッスンの挨拶はせず、現在の課題から続ける。" +
        "以下はアプリの進行状態。確定した採点は繰り返さず、中断した発話だけ再度促す。" +
        "模範解答は、現在の段階がmodelまたはdoneでない限り先に教えない。\n" +
        JSON.stringify(this.coach.checkpoint?.()) : plan.greeting,
      tools: plan.tools,
      turnTaking,
      resuming: !!checkpoint,
    };
    if (plan.image) bridgeOptions.image = plan.image;
    this.bridge = bridgeFactory(this, bridgeOptions, (msg) => this.log(msg));
  }

  checkpoint(): SessionCheckpoint | null {
    const coach = this.coach.checkpoint?.();
    return coach ? { version: 1, coach, turnSequence: this.turns.sequence } : null;
  }

  /**
   * 上流に接続する。ブラウザが付いてから呼ぶ。
   *
   * デモは HTTP の /start で先に脚を上げていて、そのせいで「ブラウザが付く前に
   * 挨拶が流れて消える」経路を15秒のタイムアウトで守る必要があった。ここでは
   * ブラウザが付いてから接続するので、その窓自体が存在しない。
   */
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    void this.bridge.start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`接続に失敗: ${message}`);
      this.emit({ type: "error", message: `先生に接続できませんでした: ${message}` });
      this.onDead(this.sessionId);
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.silencePoll) clearInterval(this.silencePoll);
    this.silencePoll = null;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.pendingFrame = null;
    this.turns.close("user");
    this.turns.close("assistant");
    this.coach.dispose();
    this.turns.dispose();
    // ブラウザに終わりを伝える。閉じないと、畳んだ後もブラウザは「聞いています」の
    // ままマイクを送り続け、終了を押すまで直らない。
    const ws = this.frontend;
    this.frontend = null;
    if (ws && (ws.readyState === 1 || ws.readyState === 0)) {
      ws.close(1000, "session ended");
    }
    await this.bridge.close();
  }

  /**
   * ブラウザの枠を1つだけ取る。すでに埋まっていれば false。
   * 同期の検査と代入なので、2つの接続が競っても両方勝つことはない。
   */
  tryAttachFrontend(ws: FrontendSocket): boolean {
    if (this.frontend) return false;
    this.frontend = ws;
    if (this.ready) this.emit({ type: "ready" });
    return true;
  }

  detachFrontend(ws: FrontendSocket): void {
    // 同一性で判定する。古いソケットが新しい接続を消せないように。
    if (this.frontend === ws) this.frontend = null;
  }

  sendMicAudio(audioB64: string): void {
    this.lastActivityAt = Date.now();
    // 録音は「話す」と「送信」の間だけ(recorder が自分で見る)。
    this.recorder?.push(audioB64);
    this.bridge.sendMicAudio(audioB64);
  }

  endMicStream(): void {
    this.bridge.endMicStream();
  }

  /** 回線切断中の音声は回答として提出しない。復帰後に改めて話してもらう。 */
  suspendInput(): void {
    this.recorder?.end(Date.now());
    if (this.turnTaking === "manual") this.bridge.endActivity();
    else this.bridge.endMicStream();
  }

  /** 学習者が「話す」を押した(手動の区切り)。ここからの音声が先生に届く。 */
  startSpeech(): void {
    this.lastActivityAt = Date.now();
    // ボタンを押したこと自体が「学習者はいる」の合図。無音の見張りに数えさせる。
    this.silence.noteUserActivity(this.lastActivityAt);
    this.recorder?.begin(this.lastActivityAt);
    this.bridge.startActivity();
    this.coach.learnerSpeechStart?.();
  }

  /** 学習者が「送信」を押した。先生はここで答え始める。 */
  endSpeech(): void {
    this.lastActivityAt = Date.now();
    this.silence.noteUserActivity(this.lastActivityAt);
    this.bridge.endActivity();
    // 録音は先生に届いた分と同じ区間。コーチが要るなら(話し直し)ここで渡す。
    const take = this.recorder?.end(this.lastActivityAt) ?? null;
    this.coach.learnerSpeechEnd?.(take);
  }

  /** 学習者の画面操作(スキップ、ヒント)。モードが解釈する。 */
  control(action: ControlAction): void {
    this.coach.onControl?.(action);
  }

  /**
   * ボード: 板の現在の姿(board_frame)。中身を検査し、1枚/秒に間引いて上流へ。
   * 間隔内に複数来たら最後の1枚だけを、間隔が明けたときに送る。壊れたフレームは
   * 学習者に見せる失敗ではないので、ログに出して捨てる。
   */
  boardFrame(raw: unknown, seq: number, now = Date.now()): void {
    if (this.stopping) return;
    // 描いていること自体が「学習者はいる」の合図。
    this.lastActivityAt = now;
    let frame: LearnerImage;
    try {
      frame = parseBoardFrame(raw);
    } catch (err) {
      this.log(`フレームを捨てた(#${seq}): ${err instanceof ImageError ? err.message : String(err)}`);
      return;
    }
    this.pendingFrame = { frame, seq };
    this.framePacer.changed(now);
    this.flushFrame(now);
  }

  private flushFrame(now: number): void {
    if (this.stopping || !this.pendingFrame) return;
    const at = this.framePacer.nextSendAt();
    if (at !== null && at > now) {
      // 間隔が明けていない。明けたときに、そのとき最新の1枚を送る(タイマーは1本)。
      if (!this.frameTimer) {
        this.frameTimer = setTimeout(() => {
          this.frameTimer = null;
          this.flushFrame(Date.now());
        }, at - now);
      }
      return;
    }
    const { frame, seq } = this.pendingFrame;
    this.pendingFrame = null;
    this.framePacer.sent(now);
    this.log(`板のフレーム #${seq} → 先生(${frame.mimeType} ${Math.round(frame.bytes / 1024)}KB)`);
    this.bridge.sendVideoFrame(frame);
    this.coach.boardChanged?.(seq);
  }

  // ── GeminiEvents ────────────────────────────────────────────────────────────

  onReady(): void {
    this.ready = true;
    this.log(`先生の準備ができた(${this.plan.label})`);
    this.emit({ type: "ready" });
    // 見張りの起点。挨拶が来る前の沈黙を「無音」と数えない。
    this.silence.start(Date.now());
    this.silencePoll = setInterval(() => this.checkSilence(), SILENCE_POLL_MS);
    this.coach.onReady?.();
  }

  onAudio(audioB64: string): void {
    this.teacherTurnActive = true;
    // 受信時刻ではなく「いつ鳴り終わるか」を覚える。音声は実時間より速く届く。
    this.silence.noteAudio(pcm16DurationMs(audioB64), Date.now());
    this.emit({ type: "audio", audio: audioB64 });
  }

  onFragment(role: "user" | "assistant", text: string, finished = false): void {
    if (role === "assistant" && text) this.teacherTurnActive = true;
    if (role === "user") this.silence.noteUserActivity(Date.now());
    this.turns.fragment(role, text, finished);
  }

  onUserSpeaking(): void {
    this.silence.noteUserActivity(Date.now());
    this.coach.learnerSpeaking?.();
  }

  onTurnComplete(): void {
    this.silence.noteTurnComplete(Date.now());
    this.closeTeacherTurn();
  }

  onInterrupted(): void {
    this.log("学習者が割り込んだ — 再生待ちを捨てる");
    // 途中で切られた発話の続きは来ない。行を閉じて、ブラウザには捨てさせる。
    this.silence.noteInterrupted(Date.now());
    this.closeTeacherTurn();
    this.emit({ type: "interrupted" });
  }

  onDisconnected(): void {
    // 張り替え中。続きの音声は来ないので行を閉じる。ブラウザに届いた分は
    // 鳴らし切ってよいので、interrupted のように捨てさせはしない。
    this.closeTeacherTurn();
  }

  onToolCall(name: string, args: Record<string, unknown>): ToolReply {
    if (this.stopping) return { response: { recorded: false, reason: "session ended" }, scheduling: "SILENT" };
    this.teacherTurnActive = true;
    return this.coach.onToolCall(name, args);
  }

  onNotice(message: string): void {
    this.log(message);
    this.emit({ type: "notice", message });
  }

  onError(message: string): void {
    this.log(`エラー: ${message}`);
    this.emit({ type: "error", message });
    this.onDead(this.sessionId);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private handleTurn(turn: Turn): void {
    this.emit({ type: "turn", ...turn });
    if (turn.role === "user") {
      this.coach.learnerSaid(turn.text, turn.done);
      return;
    }
    this.coach.teacherSaid(turn.text);
  }

  private closeTeacherTurn(): void {
    const active = this.teacherTurnActive;
    this.teacherTurnActive = false;
    this.turns.close("assistant");
    if (active && !this.stopping) this.coach.teacherTurnDone();
  }

  /**
   * 無音の見張り。先生の再生が終わり、学習者の声もしばらく無ければ、先生に声を
   * かけさせる。文言はコーチが差し替えられる(瞬間英作文なら「判定を報告して」)。
   * 判定の中身は silence.ts。
   */
  private checkSilence(): void {
    if (this.stopping || !this.frontend) return;
    const now = Date.now();
    const due = this.silence.shouldCheckin(now, {
      generating: this.bridge.generating,
      // 手動の区切りで「話す」を押したまま考えている時間も、学習者の番。
      // ここで声かけを頼むと、録っている最中に先生が喋り始める。
      userTurnOpen: this.turns.isOpen("user") || this.bridge.activityOpen,
    });
    if (!due) return;
    const custom = this.coach.silenceNudge?.();
    if (custom === null) {
      this.log(`無音 — コーチが処理(${this.silence.describe(now)})`);
      return;
    }
    this.log(`無音 — 声かけを頼む(${this.silence.describe(now)})`);
    this.bridge.nudge(custom ?? SILENCE_CHECKIN, "now");
  }

  private emit(message: ServerMessage): void {
    this.observer.onMessage?.(message);
    const ws = this.frontend;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.frontend = null;
    }
  }

  private log(msg: string): void {
    console.log(`[session ${this.sessionId.slice(0, 8)}] ${msg}`);
  }
}
