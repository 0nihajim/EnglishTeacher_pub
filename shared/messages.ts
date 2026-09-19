/**
 * ブラウザとオーケストレーターのあいだの通信規約。
 *
 * このファイルが契約そのもの。サーバーは送る型として import し、ブラウザは
 * 受け取る switch の型として import する。サーバーが送れてブラウザが描けない
 * ものがあれば、実行時の謎ではなくコンパイルエラーになる。
 *
 * 元にしたデモ(heygen-com/liveavatar-gpt-live-demos, MIT © 2026 HeyGen)との
 * 違いは1点だけで、そこが構成上いちばん大きい: 先生の音声もここを通る。デモは
 * アバターの音声を LiveKit で配っていたが、こちらは顔がないので Gemini の PCM を
 * そのままこのソケットに流し、ブラウザが鳴らす。
 */

/**
 * 学習モード。
 *  scene  = シーン会話。ユーザーが決めた表現を使う機会を先生が作り、使えたかを追う(シーンが要る)
 *  drill  = 瞬間英作文。日本語文を出し、すぐ英語で言い、先生が判定する(シーンが要る)
 *  retell = 話し直しトレーニング。学習者が選んだ画像1枚について自分の英語で話し、
 *           改善点を1〜2個確認してから同じ内容をもう一度話す(画像が要る。区切りは手動)
 *  review = 履歴から選ぶ今日の復習。自力修正、段階的なヒント、隠して再挑戦(手動)
 *  whiteboard = ボード。学習者が舞台のキャンバスに描き、先生はその板をフレームで見ながら
 *           英語で話す(画面の表示名は「ボード」。内部IDは話し直しの板 #board と衝突しないよう
 *           whiteboard)。シーンも画像も要らない。区切りは選べる(既定は自動)
 */
export type Mode = "scene" | "drill" | "retell" | "review" | "whiteboard";

/**
 * 学習者の発話の区切りを誰が決めるか。
 *  auto   = Gemini の発話区間検出(VAD)。黙ると先生が答える(最初からある動き)
 *  manual = 学習者がボタンで決める。「話す」で始め、「送信」で先生に渡す。
 *           先生は送信まで待ち、言い終える前に答え始めない
 */
export type TurnTaking = "auto" | "manual";

/** 意味を保った別表現と、次の発話で使える語の組み合わせ。 */
export interface TeachingNotes {
  alternative?: { phrase: string; usage: string };
  collocation?: { phrase: string; meaning: string; example: string };
  /** 学習者が自分で一文作るための短い課題。 */
  practice?: string;
}

export type AssessmentCriterion = "meaning" | "grammar" | "naturalness" | "range";

/** 今回の発話だけを評価する。証拠が足りなければ採点しない。 */
export interface AssessmentItem {
  criterion: AssessmentCriterion;
  score: 1 | 2 | 3 | 4 | 5 | null;
  /** 学習者の発話からの短い引用。 */
  evidence: string;
  reason: string;
}

/** term_card ウィジェットの中身。 */
export interface TermCardProps {
  /** 覚える語句そのもの。英語: "Could you say that again?" */
  term: string;
  /** 発音。日本語話者が読める形にする: "クッジュー・セイ・ザッ・アゲン" */
  reading?: string;
  /** 日本語の意味: 「もう一度言ってもらえますか」 */
  meaning?: string;
  /** 使う場面が分かる短い例文。省略可。 */
  example?: string;
}

/**
 * targets ウィジェット(シーン会話)。今日の表現と、それぞれの状態。
 * 状態は unused → modeled(先生が示した) → heard(学習者が口にした) →
 * used_with_error → used_well の順に強く、弱い方へは戻らない。
 */
export type TargetStatusKind = "unused" | "modeled" | "heard" | "used_with_error" | "used_well";

export interface TargetStatus {
  term: string;
  meaning: string;
  status: TargetStatusKind;
}

export interface TargetsProps {
  title: string;
  targets: TargetStatus[];
}

/** recast ウィジェット: 学習者の文と、表現を使った言い直し。 */
export interface RecastProps {
  /** 学習者が実際に言った文。 */
  original: string;
  /** 表現を使った、より自然な文。 */
  better: string;
  /** 何が変わったかの一言。日本語。 */
  note?: string;
  /** 正しい文の別案を、誤りの訂正と区別する。 */
  kind?: "correction" | "upgrade";
  teaching?: TeachingNotes;
}

/** drill_prompt ウィジェット: 瞬間英作文の出題。limitMs は残り時間のバーの長さ。 */
export interface DrillPromptProps {
  index: number;
  total: number;
  ja: string;
  limitMs: number;
}

export type DrillVerdict = "correct" | "close" | "wrong" | "skipped";

/** drill_answer ウィジェット: 1問の判定。said は学習者の発話(文字起こし、または先生が聞き取ったもの)。 */
export interface DrillAnswerProps {
  ja: string;
  answer: string;
  verdict: DrillVerdict;
  said?: string;
  note?: string;
  /** 出題から答え始めるまでの時間。 */
  latencyMs?: number;
  teaching?: TeachingNotes;
}

/** 復習の元になる課題。答えはホームや挑戦中のメッセージには含めない。 */
export interface ReviewSeed {
  id: string;
  kind: "translation" | "repair" | "expression";
  cue: string;
  answer: string;
  original?: string;
  note?: string;
  teaching?: TeachingNotes;
  source: string;
}

export type ReviewOutcome = "independent" | "repaired" | "hinted" | "modeled" | "again" | "skipped";
export type ReviewPhase = "recall" | "repair" | "hint" | "model" | "retry" | "done";

export interface ReviewStepProps {
  index: number;
  total: number;
  phase: ReviewPhase;
  cue: string;
  original?: string;
  hint?: string;
  said?: string;
  /** model / done のときだけサーバーから送る。 */
  answer?: string;
  note?: string;
  outcome?: ReviewOutcome;
  teaching?: TeachingNotes;
}

export interface DailyReviewPlan {
  total: number;
  due: number;
  practicedToday: number;
  estimatedMinutes: number;
  nextDueAt?: string;
  items: { id: string; cue: string; kind: ReviewSeed["kind"]; source: string }[];
}

export type ControlAction = "skip" | "hint" | "reveal" | "retry" | "next";

/** summary ウィジェット: セッションのまとめ。行の中身はモードごとに違うので文字列で持つ。 */
export type SummaryTone = "good" | "warn" | "bad" | "muted";

export interface SummaryLine {
  label: string;
  value: string;
  tone?: SummaryTone;
}

export interface SummaryProps {
  title: string;
  lines: SummaryLine[];
  footer?: string;
}

// ── 話し直しトレーニング(retell モード) ──────────────────────────────────────

/**
 * 話し直しの段階。サーバーのコーチが持ち、板(retell_board)に載せてブラウザに知らせる。
 * ブラウザはこれで「ヒント」ボタンの可否と、録音の札(1回目 / 2回目)を決める。
 *  greeting   先生の挨拶と観点の提示
 *  telling    1回目: 学習者が自分の言葉で話す(30〜60秒)
 *  analyzing  送信後。Flash が説明を整理している(先生は一言だけ言って待つ)
 *  reviewing  改善点を1〜2個、声とカードで確認
 *  retelling  2回目: 画像とキーワードだけを見て、同じ内容をもう一度
 *  retold     先生が2回目の講評と追加の質問を言っている
 *  answering  学習者が追加の質問に答える
 *  closing    先生が締めている
 *  finished   終わり。比較(retell_compare)が出る
 */
export type RetellPhase =
  | "greeting"
  | "telling"
  | "analyzing"
  | "reviewing"
  | "retelling"
  | "retold"
  | "answering"
  | "closing"
  | "finished";

/**
 * retell_board ウィジェット: 舞台の左に居座る板。画像はブラウザが自分で持っている
 * (選んだ本人の端末にある)ので、ここには載せない。文字だけが段階ごとに変わる。
 */
export interface RetellBoardProps {
  phase: RetellPhase;
  /** 段階の見出し: 「1回目 — 自分の言葉で」 */
  title: string;
  /** 1回目は話す観点、2回目はキーワード、最後は追加の質問。 */
  lines: string[];
  /** 板の下の一言。省略可。 */
  note?: string;
}

/** 改善点1つ。学習者の言い方と、意図と語彙のレベルを保った自然な言い方。 */
export interface RetellImprovement {
  original: string;
  better: string;
  /** 何が変わったかの一言。日本語。 */
  note?: string;
}

/** retell_review ウィジェット: 改善点(1〜2個)と、伝わった要点。 */
export interface RetellReviewProps {
  improvements: RetellImprovement[];
  /** 1回目で伝わった要点(日本語の短い札)。 */
  points?: string[];
  assessment?: AssessmentItem[];
  teaching?: TeachingNotes;
}

/** 1回分の話の記録(比較に使う)。 */
export interface RetellTake {
  transcript: string;
  seconds: number;
  words: number;
  /** 伝わった要点(日本語の短い札)。 */
  points: string[];
  /** その回で使ったヒントの数。 */
  hints: number;
  assessment?: AssessmentItem[];
}

/** retell_compare ウィジェット: 1回目と2回目の比較。舞台をまるごと使う。録音の再生はブラウザ側。 */
export interface RetellCompareProps {
  first: RetellTake;
  /** 2回目まで行かずに終わったときは無い。 */
  second?: RetellTake;
  improvements: (RetellImprovement & { used?: boolean })[];
  /** 先生役(Flash)の一言。良くなった点と、続けて直す点。 */
  comment?: string;
  teaching?: TeachingNotes;
}

/**
 * 画面に出す指示1件。モデルの function call もサーバーの進行も全部この形で
 * ブラウザに届くので、ブラウザ側は `widget` の switch 1つで描ける
 * (web/src/overlays/)。既存のウィジェットを使い回すツールを足すとき、
 * ブラウザ側の追加コードは0行。
 */
export type UiMessage =
  | { widget: "term_card"; props: TermCardProps }
  | { widget: "targets"; props: TargetsProps }
  | { widget: "recast"; props: RecastProps }
  | { widget: "drill_prompt"; props: DrillPromptProps }
  | { widget: "drill_answer"; props: DrillAnswerProps }
  | { widget: "review_step"; props: ReviewStepProps }
  | { widget: "summary"; props: SummaryProps }
  | { widget: "retell_board"; props: RetellBoardProps }
  | { widget: "retell_review"; props: RetellReviewProps }
  | { widget: "retell_compare"; props: RetellCompareProps }
  | { widget: "hide"; props: Record<string, never> };

/**
 * 会話1ターン。Gemini の文字起こし断片から組み立てる。途中の更新は同じ `id` で
 * 長くなった `text` を送り直すので、ブラウザはその行を書き換える。id が変わって
 * 初めて次の行に移る。
 */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  done: boolean;
}

/** サーバー → ブラウザ。 */
export type ServerMessage =
  | { type: "ready" }
  | ({ type: "turn" } & Turn)
  | ({ type: "ui" } & UiMessage)
  /** 先生の声。base64 の PCM16 モノラル 24kHz。 */
  | { type: "audio"; audio: string }
  /** 学習者が割り込んだ。再生待ちの音声はもう来ないので捨てる。 */
  | { type: "interrupted" }
  /** 進行の連絡。接続が張り替わった等、失敗ではない出来事。 */
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

/** ブラウザ → サーバー。終了の合図は別に無く、ソケットを閉じることがそれ。 */
export type ClientMessage =
  /** base64 の PCM16 モノラル 16kHz。micCapture.ts の AudioWorklet が作る。 */
  | { type: "mic_audio"; audio: string }
  /** マイクを止めた。溜まった音声を吐き出させる(audioStreamEnd)。自動の区切りのときだけ意味がある。 */
  | { type: "mic_end" }
  /**
   * 手動の区切り(TurnTaking = manual)だけ。speech_start で「いまから話す」、
   * speech_end で「言い終えた、答えて」。この間の mic_audio だけが先生に届く。
   * 音声そのものは区切りに関係なく送り続ける(サーバーの生存判定に使うため)。
   */
  | { type: "speech_start" }
  | { type: "speech_end" }
  /**
   * 画面の操作。モードが解釈する。
   *  skip = 瞬間英作文でいまの問題を飛ばす
   *  hint = 話し直しで詰まった。先生が次に言えそうな短いかたまりを1つ言う
   */
  | { type: "control"; action: ControlAction }
  /**
   * ボード(whiteboard)だけ。学習者の板の現在の姿を1枚の静止画で送る。ブラウザは描き終えて
   * 少し静止したとき、または話し始めたときに、前回から変わっていれば1枚だけ送る(上限 1枚/秒)。
   * サーバーは Gemini Live に video フレームとして流す。seq はログの照合用の連番。
   */
  | { type: "board_frame"; mime_type: string; data: string; seq: number };

/** 学習者が選んだ画像(話し直し)。ブラウザが長辺 1280px 以下に縮めてから送る。 */
export interface StartImage {
  /** image/jpeg か image/png(サーバーは中身の先頭バイトで判定し直す)。 */
  mime_type: string;
  /** base64。 */
  data: string;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** GET /api/scenes の1件。 */
export interface SceneSummary {
  id: string;
  title: string;
  targets: number;
  drills: number;
}

/**
 * POST /api/session/start の body。省けばシーン会話、自動の区切り。
 * scene / drill は scene_id が必須。retell は image が必須。review は履歴から課題を選ぶ。
 * whiteboard は何も要らない(板は接続後に board_frame で届く)。
 * retell / review の区切りは手動に固定される。
 */
export interface StartRequest {
  mode?: Mode;
  scene_id?: string;
  turn_taking?: TurnTaking;
  image?: StartImage;
}

export interface StartResponse {
  session_id: string;
  ws_path: string;
  mode: Mode;
  /** サーバーが実際に適用した区切り方。ブラウザはこれを見てボタンの役を決める。 */
  turn_taking: TurnTaking;
  scene_title?: string;
  /** クラウド版の、認証済み再接続チケットの発行先。 */
  resume_path?: string;
  recording?: { enabled: boolean; maxBytes: number };
}
