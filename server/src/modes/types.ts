/**
 * モードごとの方針(コーチ)の共通の形。
 *
 * Session(配線)はここだけを見る。コーチはソケットも Gemini も知らず、
 * 画面への出力と先生への差し込みを CoachHost 経由で外に頼む。
 * modes/scene.ts(シーン会話)、modes/drill.ts(瞬間英作文)、
 * modes/retell.ts(話し直しトレーニング)、modes/review.ts(個人復習)、
 * modes/whiteboard.ts(ボード)。
 */

import type { Mode, UiMessage } from "../../../shared/messages";
import type { ToolDef } from "../../../shared/tools";
import type { NudgeMode, ToolReply } from "../gemini";
import type { LearnerImage } from "../image";
import type { Take } from "../takes";
import type { CoachCheckpoint } from "./checkpoint";

export interface CoachHost {
  /** 画面に出す。 */
  showUi(ui: UiMessage): void;
  /** 先生に進行の指示を差し込む。mode の意味は gemini.ts の NudgeMode。 */
  nudge(text: string, mode: NudgeMode): void;
  log(msg: string): void;
  /** 先生がいま喋っている(生成中)か。 */
  teacherSpeaking(): boolean;
}

export interface Coach {
  checkpoint?(): CoachCheckpoint;
  restore?(checkpoint: CoachCheckpoint): boolean;
  /** 先生の準備ができた(挨拶の直前)。最初の画面を出すのに使う。 */
  onReady?(): void;
  /** モデルのツール呼び出し1件。結果を必ず返す(返さないと保留のまま溜まる)。 */
  onToolCall(name: string, args: Record<string, unknown>): ToolReply;
  /** 先生の発話(途中経過を含む、そのターンの全文)。 */
  teacherSaid(text: string): void;
  /** 先生のターンが閉じた(turnComplete、割り込み、切断)。 */
  teacherTurnDone(): void;
  /** 学習者の発話(途中経過を含む、そのターンの全文)。done は行が閉じたとき。 */
  learnerSaid(text: string, done: boolean): void;
  /** 学習者が話し始めた(暫定の文字起こし)。文字が来るより早い合図。 */
  learnerSpeaking?(): void;
  /** 手動の区切り: 学習者が「話す」を押した。 */
  learnerSpeechStart?(): void;
  /**
   * 手動の区切り: 学習者が「送信」を押した。take はその間の録音
   * (SessionPlan.captureSpeech のときだけ。そうでなければ null)。
   */
  learnerSpeechEnd?(take: Take | null): void;
  /** 学習者が画面の操作をした(スキップ、ヒントなど)。 */
  onControl?(action: string): void;
  /** ボード: 板のフレームを1枚、先生に送った(間引き後)。seq はブラウザの連番。 */
  boardChanged?(seq: number): void;
  /**
   * 無音が続いたときに先生へ差し込む文。
   * undefined = 既定の声かけ、null = 何も差し込まない(コーチが自分で処理した)。
   */
  silenceNudge?(): string | null | undefined;
  dispose(): void;
}

/** セッション1本の計画。system instruction と挨拶と、宣言するツールと、コーチ。 */
export interface SessionPlan {
  mode: Mode;
  /** ログ・レスポンス用の短い名前。 */
  label: string;
  systemInstruction: string;
  greeting: string;
  tools: readonly ToolDef[];
  /** 学習者が選んだ画像。接続の直後、挨拶の前に先生に渡す(話し直し)。 */
  image?: LearnerImage;
  /** 「話す」から「送信」までの音声を録り、learnerSpeechEnd に渡す(話し直し)。 */
  captureSpeech?: boolean;
  coach(host: CoachHost): Coach;
}
