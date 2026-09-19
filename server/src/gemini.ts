/**
 * Gemini Live API との1本の脚。元デモの server/src/gptlive.ts(534行)に対応する
 * ファイルで、いちばん縮んだところでもある。
 *
 * 消えたもの:
 *  - 委譲機構。GPT-Live はツールを持たず、画面に何か出したいときは裏の Responses
 *    モデルにターンを渡し、返ってきた言葉をライブ側に注入していた。Gemini Live は
 *    自分で function calling を持つので、この二段構えが要らない。
 *  - ターン検出の再構成の大半。Gemini は turnComplete と interrupted を明示的に
 *    送ってくるので、タイマーで推測する部分が減る。
 *
 * 増えたもの:
 *  - 接続の張り替え。Gemini の1接続は約10分で切れる(セッションは resumption
 *    ハンドルで継続する)。goAway を受けたら次の close で新しい接続を開き、
 *    ハンドルを渡して会話を続ける。これが「20分レッスンをどう回すか」の答え。
 *  - contextWindowCompression。これを入れないと音声のみセッションは15分で終わる。
 *  - 板のフレーム(ボード)。学習者が描いた板の姿を realtimeInput の video として流す。
 *    生成中でも割り込まない経路なので、描いている最中に送っても先生の発話は切れない。
 *
 * 実通話で分かった、この API の2つの性質。ここの配線はどちらにも従っている:
 *  - 音声は実時間ではなく、1ターン分が数秒でまとめて届く。「先生がいつ喋り終わるか」は
 *    受信時刻からは分からない(session.ts / silence.ts が届いた長さから見積もる)。
 *  - clientContent は turnComplete の真偽に関係なく、生成中なら割り込む。進行の
 *    差し込み(nudge)は生成が終わるまで待たせる。
 *
 * 発話の区切り(TurnTaking)は接続時に決まり、途中では変えられない:
 *  - auto   … 上流の VAD。ブラウザから来た音声は全部そのまま流す。
 *  - manual … VAD を切り(automaticActivityDetection.disabled)、学習者のボタンを
 *             activityStart / activityEnd に写す。音声はその間だけ流し、外は捨てる。
 *             audioStreamEnd はこの構成では送らない(公式ドキュメント)。
 */

import {
  Behavior,
  EndSensitivity,
  FunctionResponseScheduling,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  Type,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Part,
  type Session,
} from "@google/genai";
import type { TurnTaking } from "../../shared/messages";
import type { Scheduling, ToolDef } from "../../shared/tools";
import { config } from "./config";
import type { LearnerImage } from "./image";
import { pcm16DurationMs } from "./silence";

/** 再接続の待ち時間。1回ごとに1つ進み、使い切ったら諦める(5回)。 */
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

/** 発話の頭として拾う最短の長さ。短いほど敏感だが、物音を発話と取りやすい。 */
const VAD_PREFIX_PADDING_MS = 300;

/** ツール結果として返すもの。scheduling は shared/tools.ts の既定を上書きできる。 */
export interface ToolReply {
  response: Record<string, unknown>;
  scheduling: Scheduling;
}

/**
 * 進行指示の届け方。
 *  now       = turnComplete: true。いま喋らせる(挨拶、無音の声かけ)。
 *  next-turn = turnComplete: false。文脈に追記だけして、学習者の次の発話と一緒に
 *              処理させる(復習休憩)。学習者の番を奪わない。
 */
export type NudgeMode = "now" | "next-turn";

export interface GeminiEvents {
  /** 最初の接続が確立した(2回目以降は onNotice になる)。 */
  onReady(): void;
  /** 先生の声。base64 PCM16 24kHz。 */
  onAudio(audioB64: string): void;
  /** 文字起こしの断片。finished は上流が「この文字起こしはここで終わり」と言ったとき。 */
  onFragment(role: "user" | "assistant", text: string, finished?: boolean): void;
  /** 学習者が話している途中(暫定の文字起こしが動いた)。ターンは作らない。 */
  onUserSpeaking(): void;
  /** モデルが1ターン喋り終えた。 */
  onTurnComplete(): void;
  /** 学習者が割り込み、生成が破棄された。 */
  onInterrupted(): void;
  /** 上流の接続が切れた(張り替え中)。進行中だった発話の続きは来ない。 */
  onDisconnected(): void;
  /** ツール呼び出し。同期で結果を返す。 */
  onToolCall(name: string, args: Record<string, unknown>): ToolReply;
  onNotice(message: string): void;
  onError(message: string): void;
}

const SCHEDULING: Record<Scheduling, FunctionResponseScheduling> = {
  SILENT: FunctionResponseScheduling.SILENT,
  WHEN_IDLE: FunctionResponseScheduling.WHEN_IDLE,
  INTERRUPT: FunctionResponseScheduling.INTERRUPT,
};

/** 1セッションの設定。モードごとに変わるもの(modes/index.ts が組む)。 */
export interface BridgeOptions {
  /** アプリのチェックポイントから再開する場合、開幕の定型文を付けない。 */
  resuming?: boolean;
  systemInstruction: string;
  /** 開幕の指示。最初の接続が立った直後に [進行] として送る。 */
  greeting: string;
  /** このセッションで宣言するツール。モードに要らないものは見せない。 */
  tools: readonly ToolDef[];
  /** 学習者の発話の区切りを誰が決めるか(shared/messages.ts の TurnTaking)。 */
  turnTaking: TurnTaking;
  /**
   * 学習者が選んだ画像(話し直し)。最初の接続が立った直後、挨拶の前に先生に渡す。
   * 経路は config.gemini.imageVia(realtime = sendRealtimeInput の video、
   * content = 挨拶と同じ clientContent の inlineData)。張り替えでは送り直さない —
   * 会話の文脈は resumption ハンドルで戻り、画像もその中にある。
   */
  image?: LearnerImage;
}

/** shared/tools.ts の定義を Gemini の FunctionDeclaration に写す。 */
function declarations(tools: readonly ToolDef[]): FunctionDeclaration[] {
  return tools.map((def) => ({
    name: def.name,
    description: def.description,
    // NON_BLOCKING が既定だが明示する。これがないと結果を返すまでモデルが黙り、
    // カードを出すたびに会話が止まる。
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        Object.entries(def.parameters).map(([name, description]) => [
          name,
          { type: Type.STRING, description },
        ]),
      ),
      required: def.required,
    },
  }));
}

export class GeminiLiveBridge {
  private readonly ai: GoogleGenAI;
  private session: Session | null = null;
  /** 直近の resumption ハンドル。接続が切れてもこれがあれば会話が続く。 */
  private handle: string | undefined;
  private stopping = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 張り替え予告を受けた。次の close はエラーではない。 */
  private expectingHandover = false;
  /** 開幕の一言を送ったか。張り替えのたびに挨拶し直さないため。 */
  private greeted = false;
  private micDropWarned = false;
  /** モデルが生成中(音声か字幕が届き始めてから turnComplete / interrupted まで)。 */
  private generatingNow = false;
  /** 送れなかった進行指示。生成中(割り込んでしまう)と張り替え中(届かない)に溜まる。 */
  private pendingNudges: { text: string; mode: NudgeMode; image?: LearnerImage }[] = [];
  /** 手動の区切り: 学習者が「話す」を押してから「送信」を押すまで true。 */
  private activityOpenNow = false;
  /** ボード: 直近に頼まれたフレーム。張り替えのあと、新しい接続にも見せる。 */
  private lastFrame: LearnerImage | null = null;
  /** connect() を呼んでから setup が通るまで true。この間の close は setup の拒否。 */
  private connecting = false;
  /**
   * 文字起こしに渡す言語のヒント。上流が受け付けなければ(setup が拒否されれば)
   * 空にして繋ぎ直す。言語の制限そのものは system instruction 側にもあるので、
   * ヒントが無くても目的の大半は残る。
   */
  private languageHints: string[] = [...config.gemini.inputLanguages];
  /** debug ログ用: 接続からの経過と、このターンで届いた音声の累計。 */
  private connectedAt = 0;
  private turnAudioMs = 0;

  constructor(
    private readonly events: GeminiEvents,
    private readonly opts: BridgeOptions,
    private readonly log: (msg: string) => void,
  ) {
    this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  }

  /** モデルが喋っている(生成している)最中か。無音の見張りが読む。 */
  get generating(): boolean {
    return this.generatingNow;
  }

  /** 手動の区切りで、学習者の発話が開いている(「話す」の後、「送信」の前)か。 */
  get activityOpen(): boolean {
    return this.activityOpenNow;
  }

  /** 最初の接続。失敗はそのまま投げる(セッションを始められない)。 */
  async start(): Promise<void> {
    await this.connect();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.pendingNudges = [];
    this.lastFrame = null;
    this.activityOpenNow = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const session = this.session;
    this.session = null;
    try {
      session?.close();
    } catch {
      /* すでに閉じている */
    }
  }

  /** マイク音声を上流へ。base64 PCM16 16kHz。 */
  sendMicAudio(audioB64: string): void {
    // 手動の区切りでは「話す」と「送信」の間だけ。外の音声(先生の声のエコー、
    // 考えている間の物音)は上流に聞かせない。ブラウザは区切りに関係なく送り続ける
    // (registry.ts の生存判定がそれを見ている)ので、捨てるのはここ。
    if (this.opts.turnTaking === "manual" && !this.activityOpenNow) return;
    const session = this.session;
    if (!session) {
      // 張り替え中の数百ms。落とすしかないが、黙って落とすと
      // 「聞こえていない」の原因が見えなくなる。
      if (!this.micDropWarned) {
        this.micDropWarned = true;
        this.log("マイク音声を破棄中(接続の張り替え待ち)");
      }
      return;
    }
    this.micDropWarned = false;
    session.sendRealtimeInput({
      audio: { data: audioB64, mimeType: "audio/pcm;rate=16000" },
    });
  }

  /** マイクを止めた合図。溜まっている音声を上流に処理させる(自動の区切りだけ)。 */
  endMicStream(): void {
    // 手動の区切りでは送らない。公式ドキュメントに「この構成では audioStreamEnd は
    // 送らず、区切りは activityEnd で示す」とある。
    if (this.opts.turnTaking === "manual") return;
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  /**
   * 学習者が「話す」を押した。ここから「送信」までの音声が1回の発話になる。
   * 先生が喋っている最中なら、この合図が割り込み(interrupted)になる。
   * 張り替え中なら開いたことだけ覚え、次の接続が立ったときに送り直す。
   */
  startActivity(): void {
    if (this.opts.turnTaking !== "manual" || this.stopping || this.activityOpenNow) return;
    this.activityOpenNow = true;
    if (!this.session) {
      this.log("発話の開始を保留(接続の張り替え待ち)");
      return;
    }
    this.debug("→ activityStart");
    this.session.sendRealtimeInput({ activityStart: {} });
  }

  /**
   * 学習者が「送信」を押した。上流はここで即座に発話を閉じて答え始める
   * (無音の猶予は無い — 公式ドキュメント)。ブラウザは直前の音声を出し切って
   * からこれを送るので、末尾が切れることはない。
   */
  endActivity(): void {
    if (this.opts.turnTaking !== "manual" || !this.activityOpenNow) return;
    this.activityOpenNow = false;
    if (!this.session) {
      // 張り替え中に押された。開始の合図もまだ届いていないので、この発話は上流に
      // 存在しない。黙って落とすと「答えが来ない」の原因が見えなくなる。
      this.log("発話の終わりを送れない(接続の張り替え待ち)— この発話は届かない");
      return;
    }
    this.debug("→ activityEnd");
    this.session.sendRealtimeInput({ activityEnd: {} });
  }

  /**
   * 進行の指示を差し込む。Gemini Live に「instructions を追記する」API はないので、
   * 括弧付きの user ターンとして送り、system instruction 側で
   * 「[進行] で始まる発言は運営からの指示で、学習者の声ではない」と教えてある。
   *
   * clientContent は生成中の発話を無条件に切る(turnComplete の真偽に関係なく、
   * SDK の注釈にそうある)。だから生成中は送らず、turnComplete まで持っておく。
   * 張り替え中も同じで、次の接続が立ってから送る。
   */
  nudge(text: string, mode: NudgeMode = "now", image?: LearnerImage): void {
    if (this.stopping) return;
    if (this.generatingNow || !this.session) {
      const pending: (typeof this.pendingNudges)[number] = { text, mode };
      if (image) pending.image = image;
      this.pendingNudges.push(pending);
      this.debug(
        `nudge を保留(${this.generatingNow ? "生成中" : "接続待ち"}) ${mode} "${text.slice(0, 40)}"`,
      );
      return;
    }
    this.debug(`→ clientContent turnComplete=${mode === "now"}${image ? " +画像" : ""} "${text.slice(0, 40)}"`);
    // 画像を添えるときは同じターンの先頭に置く(公式の作法: テキストより前にメディア)。
    const parts: Part[] = [];
    if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    parts.push({ text: `[進行] ${text}` });
    this.session.sendClientContent({
      turns: [{ role: "user", parts }],
      turnComplete: mode === "now",
    });
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private flushPendingNudges(): void {
    if (this.pendingNudges.length === 0 || this.generatingNow || !this.session) return;
    const queued = this.pendingNudges;
    this.pendingNudges = [];
    for (const { text, mode, image } of queued) this.nudge(text, mode, image);
  }

  /**
   * 学習者の画像を先生に渡す(話し直し)。挨拶の指示より前に、1回だけ。
   * 公式ドキュメントが画像に使っている経路は realtimeInput の video(JPEG/PNG の
   * 静止画を「1フレーム」として送る)。順序の保証は無いが、続く挨拶は clientContent
   * なので、実際にはこの後に処理される。もう一方(content)は挨拶の指示と同じターンの
   * inlineData で、順序は確実だが Live の公式ドキュメントには載っていない。
   */
  private sendImage(image: LearnerImage): void {
    if (!this.session) return;
    this.debug(`→ realtimeInput video ${image.mimeType} ${Math.round(image.bytes / 1024)}KB`);
    this.session.sendRealtimeInput({ video: { data: image.data, mimeType: image.mimeType } });
  }

  /**
   * 板の現在の姿を1フレーム送る(ボード)。realtimeInput なので生成中でも割り込まない
   * (clientContent と違う)。間引きは呼ぶ側(session.ts)が済ませている。
   *
   * 張り替え中は最新の1枚を持っておき、次の接続が立ったら送る。過去のフレームは
   * resumption の文脈に残るが、いまの板がどう見えているかは改めて見せる。
   */
  sendVideoFrame(frame: LearnerImage): void {
    if (this.stopping) return;
    this.lastFrame = frame;
    if (!this.session) {
      this.debug("フレームを保留(接続待ち)");
      return;
    }
    this.sendImage(frame);
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    const resuming = this.handle !== undefined;
    const manual = this.opts.turnTaking === "manual";
    const hints = this.languageHints;
    this.log(
      `${resuming ? "Gemini に再接続(セッション継続)" : "Gemini に接続"}` +
        `(区切り: ${manual ? "手動" : "自動"}${hints.length > 0 ? `, 言語ヒント: ${hints.join(",")}` : ""})`,
    );

    // SDK の connect() は setupComplete が届くまで resolve せず、上流が setup を
    // 拒否して閉じたときも reject しない(onclose だけが呼ばれる)。だから拒否の
    // 検知は handleClose 側にあり、この旗がその判別に使われる。SDK が同期的に
    // 投げた(設定の検証など)ときだけ finally で下ろす。
    this.connecting = true;
    const session = await this.connectUpstream(manual, hints).finally(() => {
      this.connecting = false;
    });

    if (this.stopping) {
      // await の間に close() が呼ばれた。ここで捨てないと、誰も閉じない接続が残る。
      try {
        session.close();
      } catch {
        /* すでに閉じている */
      }
      return;
    }
    this.session = session;
    this.afterSetup();
  }

  private connectUpstream(manual: boolean, hints: readonly string[]): Promise<Session> {
    return this.ai.live.connect({
      model: config.gemini.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: config.gemini.voice } },
        },
        systemInstruction: this.opts.systemInstruction,
        tools: [{ functionDeclarations: declarations(this.opts.tools) }],
        // 両方向の文字起こし。字幕・カードの安全網・復習記録がこれで作れる。
        // ネイティブ音声出力モデルは AUDIO しか返さないので、テキストは
        // これを有効にして初めて手に入る。
        // 入力側には学習者の言語のヒントを付ける(BCP-47)。初級者の英語が別の
        // 言語として書き起こされるのを減らす。上流が受け付けなければ handleClose
        // が外して繋ぎ直す。
        inputAudioTranscription: hints.length > 0 ? { languageCodes: [...hints] } : {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: manual
            ? // 学習者がボタンで区切る。上流は activityStart / activityEnd だけを見る。
              { disabled: true }
            : // 発話区間の検出。既定は開始・終了とも HIGH で、初級者の文中の息継ぎで
              // 「言い終えた」になり、学習者が話し終える前に先生が答え始める。
              // 終了側を鈍くして、無音の必要時間を長くとる。
              {
                startOfSpeechSensitivity:
                  config.gemini.vad.startSensitivity === "HIGH"
                    ? StartSensitivity.START_SENSITIVITY_HIGH
                    : StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                prefixPaddingMs: VAD_PREFIX_PADDING_MS,
                silenceDurationMs: config.gemini.vad.silenceMs,
              },
        },
        // これが無いと音声のみセッションは15分で打ち切られる。
        contextWindowCompression: { slidingWindow: {} },
        // ハンドルを受け取るための宣言。resuming のときは前回のハンドルを渡す。
        sessionResumption: this.handle ? { handle: this.handle } : {},
      },
      callbacks: {
        onopen: () => this.log("上流ソケット open"),
        onmessage: (message: LiveServerMessage) => this.handleMessage(message),
        onerror: (e: ErrorEvent) => {
          this.log(`上流エラー: ${e.message}`);
        },
        onclose: (e: CloseEvent) => this.handleClose(e.reason),
      },
    });
  }

  /**
   * 接続が立った直後。ここが音声やテキストを送れる最初の場所。
   *
   * SDK は setupComplete をキューに入れ、connect() が resolve する直前に onmessage へ
   * 流す。つまり handleMessage が setupComplete を見る時点では this.session がまだ
   * 入っていない。挨拶をそこで送ると this.session?.sendClientContent が黙って何も
   * せず、開幕は一度も起きない(実際にそうなっていた)。
   */
  private afterSetup(): void {
    this.attempt = 0;
    this.micDropWarned = false;
    this.connectedAt = Date.now();
    this.turnAudioMs = 0;
    if (!this.greeted) {
      this.greeted = true;
      this.events.onReady();
      // 学習者はまだ何も言っていない。先に喋らせる。画像があれば、その前に見せる。
      const opening = this.opts.resuming ? this.opts.greeting :
        "セッションが始まった。学習者はまだ話していない。いますぐ自分から話しかけて、" +
        `次の内容で会話を開いてほしい: ${this.opts.greeting}`;
      const image = this.opts.image;
      if (image && config.gemini.imageVia === "realtime") {
        this.sendImage(image);
        this.nudge(opening);
      } else {
        this.nudge(opening, "now", image);
      }
    } else {
      this.events.onNotice("接続を張り替えました(会話は続いています)");
      // ボード: 新しい接続にも、いまの板を見せる。過去のフレームは文脈に残っているが、
      // 「これ」「ここ」が指す最新の姿は改めて渡す。
      if (this.lastFrame) this.sendImage(this.lastFrame);
    }
    // 張り替えの前から学習者が話している途中なら、新しい接続にも開始を伝える。
    // 切れていた間の音声は届いていないが、ここからの分は1回の発話として届く。
    if (this.activityOpenNow && this.session) {
      this.debug("→ activityStart(張り替え後に送り直し)");
      this.session.sendRealtimeInput({ activityStart: {} });
    }
    // 張り替え中に溜まった指示があれば、ここで届ける。
    this.flushPendingNudges();
  }

  private handleClose(reason: string): void {
    if (this.stopping) return;
    this.session = null;
    this.generatingNow = false;
    this.turnAudioMs = 0;
    const expected = this.expectingHandover;
    this.expectingHandover = false;
    const duringSetup = this.connecting;
    this.connecting = false;
    this.log(`上流ソケット close${reason ? `: ${reason}` : ""}`);
    if (duringSetup && this.languageHints.length > 0) {
      // setup が通る前に閉じられた。設定のどこかが拒まれた可能性が高く、
      // この中で唯一ドキュメントに無い項目が言語ヒント。外して一度だけやり直す。
      // 別の原因(鍵、ネットワーク)ならこの再試行も同じ理由で閉じ、下の経路に落ちる。
      this.log(`setup が通らなかった — 言語ヒント(${this.languageHints.join(",")})を外して接続し直す`);
      this.languageHints = [];
      void this.connect().catch((err: unknown) => {
        this.log(`再接続に失敗: ${err instanceof Error ? err.message : String(err)}`);
        this.events.onError("先生との接続が切れました。もう一度始めてください");
      });
      return;
    }
    if (this.handle === undefined && !expected) {
      // ハンドルが無い状態で落ちた。継続しようがないので終わりにする。
      this.events.onError("先生との接続が切れました。もう一度始めてください");
      return;
    }
    // 生成中だった発話の続きは来ない。開いている字幕の行を閉じてもらう。
    this.events.onDisconnected();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const wait = RECONNECT_BACKOFF_MS[this.attempt];
    if (wait === undefined) {
      // 待ち時間の表を使い切った。もう試さない。
      this.events.onError("先生との接続を復帰できませんでした。もう一度始めてください");
      return;
    }
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err: unknown) => {
        this.log(`再接続に失敗: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleReconnect();
      });
    }, wait);
  }

  private handleMessage(message: LiveServerMessage): void {
    if (message.setupComplete) {
      // 接続直後にやることは afterSetup() にある。SDK はこのメッセージを connect() が
      // resolve する前に流すので、ここでは this.session がまだ無い。
      this.debug("setupComplete");
    }

    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) this.handle = update.newHandle;
    }

    if (message.goAway) {
      // 予告。次の close は障害ではなく通常運転。
      this.expectingHandover = true;
      this.log(`張り替え予告: あと ${message.goAway.timeLeft ?? "?"}`);
    }

    const content = message.serverContent;
    if (content) {
      // 1イベントに複数の part が同時に入るので、全部見る。
      // どれかで早期 return すると音声か字幕のどちらかが落ちる。
      const inputTx = content.inputTranscription;
      if (inputTx && (inputTx.text || inputTx.finished)) {
        this.debug(`inTx${inputTx.finished ? " finished" : ""} "${inputTx.text ?? ""}"`);
        this.events.onFragment("user", inputTx.text ?? "", inputTx.finished === true);
      }

      // 暫定の文字起こし。来るなら「学習者がいま話している」の最速の合図。
      const interim = content.interimInputTranscription?.text;
      if (interim) {
        this.debug(`interimInTx "${interim}"`);
        this.events.onUserSpeaking();
      }

      const outputText = content.outputTranscription?.text;
      if (outputText) {
        this.generatingNow = true;
        this.debug(`outTx "${outputText}"`);
        this.events.onFragment("assistant", outputText);
      }

      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData?.data;
        if (!audio) continue;
        this.generatingNow = true;
        if (config.gemini.debug) {
          const ms = pcm16DurationMs(audio);
          this.turnAudioMs += ms;
          this.debug(`audio ${Math.round(ms)}ms(このターン累計 ${Math.round(this.turnAudioMs)}ms)`);
        }
        this.events.onAudio(audio);
      }

      // generationComplete = もう音声は増えない。ただし turnComplete は再生終了の
      // 見込みまで待って届く(SDK の注釈)。行を閉じる合図は turnComplete の1回きり。
      // 前者で閉じると後から届いた字幕断片が別の行に割れる。
      if (content.generationComplete) this.debug("generationComplete");

      if (content.interrupted) {
        this.debug("interrupted");
        this.generatingNow = false;
        this.turnAudioMs = 0;
        this.events.onInterrupted();
      }

      if (content.turnComplete) {
        this.debug(
          `turnComplete reason=${content.turnCompleteReason ?? "-"} status=${content.interactionStatus ?? "-"}` +
            (content.waitingForInput ? " waitingForInput" : ""),
        );
        this.generatingNow = false;
        this.turnAudioMs = 0;
        this.events.onTurnComplete();
        // 生成中に頼まれた指示は、モデルが黙ったいまが送る番。
        this.flushPendingNudges();
      }
    }

    const calls = message.toolCall?.functionCalls ?? [];
    // ツール呼び出しはモデルのターンの一部。音声がまだ届いていなくても、
    // このあと turnComplete が来る = 生成中。ここで立てないと、呼び出しへの
    // 反応として送る nudge がモデルの発話に割り込む。
    if (calls.length > 0) this.generatingNow = true;
    for (const call of calls) {
      if (!call.name) continue;
      const reply = this.events.onToolCall(call.name, (call.args ?? {}) as Record<string, unknown>);
      const scheduling = SCHEDULING[reply.scheduling];
      // 返さないと NON_BLOCKING でも保留のまま溜まる。エラーでも必ず返す。
      // scheduling は2か所に書く。公式ドキュメントは response の中に入れる例を示し、
      // SDK の型は FunctionResponse 直下に持つ。どちらが効くかは実通話で確定するまで
      // 両方に入れておく(片方しか読まれなくても害は無い)。
      this.session?.sendToolResponse({
        functionResponses: [
          {
            id: call.id,
            name: call.name,
            response: { ...reply.response, scheduling },
            scheduling,
          },
        ],
      });
    }

    if (message.toolCallCancellation) {
      // 割り込みで保留の呼び出しが破棄された。すでに描いたものは残して構わない。
      this.log(`ツール呼び出しが取り消された: ${message.toolCallCancellation.ids?.join(",") ?? ""}`);
    }

    if (config.gemini.debug && message.usageMetadata) {
      this.log(`トークン累計: ${message.usageMetadata.totalTokenCount ?? "?"}`);
    }
  }

  /** GEMINI_DEBUG=1 のときだけ、接続からの経過時間付きで出す。 */
  private debug(msg: string): void {
    if (!config.gemini.debug) return;
    const t = this.connectedAt ? `+${((Date.now() - this.connectedAt) / 1000).toFixed(2)}s ` : "";
    this.log(`${t}${msg}`);
  }
}
