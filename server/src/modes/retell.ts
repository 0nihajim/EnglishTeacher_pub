/**
 * 話し直しトレーニングのコーチ。学習者が選んだ画像1枚について、自分の英語で話す →
 * 改善点を1〜2個確認 → 同じ内容をもう一度話す → 追加の質問に答える、を1本の流れで進める。
 *
 * 進行はここが持つ。段階(RetellPhase)を進める合図は3つだけで、どれもモデルの
 * 気分に依らない:
 *  - 学習者の「送信」(learnerSpeechEnd)。1回目・2回目・答えの区切り
 *  - 先生のターンが閉じた(teacherTurnDone)。挨拶・講評・質問・締めの区切り
 *  - Flash の整理が返った(analyst)。改善点・キーワード・追加の質問はここから来る
 * 先生には段階ごとに [進行] で「次に届く発話は何か、終わったら何を言うか」を先に
 * 文脈に足しておく(next-turn)。学習者の番を奪わないため。
 *
 * このモードでは、無音の声かけを止め(silenceNudge は null)、話の途中の訂正も
 * させない(retell.md)。詰まったときは学習者が「ヒント」を押し、それだけが割り込みになる。
 *
 * 音声モデルではなく Flash に整理を頼む理由は flash.ts の冒頭。
 */

import type {
  AssessmentItem,
  RetellBoardProps,
  RetellCompareProps,
  RetellPhase,
  RetellReviewProps,
  RetellTake,
} from "../../../shared/messages";
import type { Analyst, RetellAnalysis, TellingAnalysis } from "../flash";
import type { ToolReply } from "../gemini";
import type { LearnerImage } from "../image";
import {
  DEFAULT_RETELL_QUESTION,
  RETELL_ANSWER_NUDGE,
  RETELL_FALLBACK_REVIEW_NUDGE,
  RETELL_FILLER_NUDGE,
  RETELL_HINT_NUDGE,
  retellPromptLines,
  retellRetellNudge,
  retellReviewNudge,
} from "../prompts";
import type { RetellResultRow } from "../results";
import type { Take } from "../takes";
import { dispatchToolCall } from "../tools";
import { mentions, normalizeTerm } from "./match";
import type { Coach, CoachHost } from "./types";
import { capture, restore, type CoachCheckpoint } from "./checkpoint";

const CHECKPOINT_KEYS = ["phase", "firstAnalysis", "firstFailed", "secondAnalysis", "secondFailed", "answer",
  "lines", "hints", "ackDone", "fillerSent", "compareShown", "persisted"] as const;

export interface RetellOptions {
  analyst: Analyst;
  clock: () => number;
  /** これより短い送信は「押し間違えた」と見て、段階を進めない。 */
  minTakeMs: number;
  /** 先生の一言が終わってから整理がこれだけ来なければ、つなぎの一言を頼む(1回だけ)。 */
  fillerMs: number;
  /**
   * 送信からこれだけは講評を始めない。先生の一言の生成が始まる前に講評の指示を
   * 差し込むと、その一言に割り込んで二重に喋らせることになる。
   */
  reviewFloorMs: number;
  /** セッションの記録(比較が出たとき、または途中終了のとき)。 */
  onOutcome?: (row: RetellResultRow) => void;
}

export const DEFAULT_RETELL_OPTIONS: Omit<RetellOptions, "analyst"> = {
  clock: Date.now,
  minTakeMs: 1_500,
  fillerMs: 7_000,
  reviewFloorMs: 2_500,
};

/** 板の見出し。段階ごと。 */
export const RETELL_TITLES: Record<RetellPhase, string> = {
  greeting: "1回目 — 自分の言葉で",
  telling: "1回目 — 自分の言葉で",
  analyzing: "整理しています…",
  reviewing: "改善点を確認",
  retelling: "2回目 — 画像とキーワードだけで",
  retold: "2回目 — 画像とキーワードだけで",
  answering: "追加の質問",
  closing: "追加の質問",
  finished: "おつかれさまでした",
};

/** ヒントが押せる段階(学習者が話す番)。 */
const HINT_PHASES: ReadonlySet<RetellPhase> = new Set(["telling", "retelling", "answering"]);

interface TakeRecord {
  take: Take;
  /** 字幕(Live の文字起こし)の行。送信の後に届いた分も、次の「話す」まで同じ配列に足す。 */
  lines: string[];
  /** その回で使ったヒントの数。 */
  hints: number;
}

export class RetellCoach implements Coach {
  checkpoint(): CoachCheckpoint {
    const snapshot = capture(this, "retell", CHECKPOINT_KEYS);
    // 採点済みテイクの時刻・字幕だけを残す。PCM は永続ストレージへ書き込まない。
    const take = (value: TakeRecord | null) => value ? {
      lines: [...value.lines], hints: value.hints,
      take: { durationMs: value.take.durationMs, startedAt: value.take.startedAt, endedAt: value.take.endedAt, truncated: value.take.truncated },
    } : null;
    snapshot.state.first = take(this.first);
    snapshot.state.second = take(this.second);
    return snapshot;
  }
  restore(checkpoint: CoachCheckpoint): boolean {
    if (!restore(this, checkpoint, "retell", CHECKPOINT_KEYS)) return false;
    const take = (value: unknown): TakeRecord | null => {
      if (!value || typeof value !== "object") return null;
      const saved = value as Omit<TakeRecord, "take"> & { take: Omit<Take, "pcm"> };
      return { ...saved, take: { ...saved.take, pcm: Buffer.alloc(0) } };
    };
    this.first = take(checkpoint.state.first);
    this.second = take(checkpoint.state.second);
    if (this.first && !this.firstAnalysis) {
      this.first = null;
      this.phase = "telling";
    } else if (this.second && !this.secondAnalysis) {
      this.second = null;
      this.phase = "retelling";
    }
    this.lines = [];
    this.ackDone = false;
    return true;
  }
  private readonly opts: RetellOptions;
  private phase: RetellPhase = "greeting";

  private first: TakeRecord | null = null;
  private firstAnalysis: TellingAnalysis | null = null;
  private firstFailed = false;
  private second: TakeRecord | null = null;
  private secondAnalysis: RetellAnalysis | null = null;
  private secondFailed = false;
  private answer = "";

  /** いまの発話の字幕。「話す」で新しい配列になる。 */
  private lines: string[] = [];
  /** いまの段階で使ったヒントの数。 */
  private hints = 0;
  /** 整理待ちで、先生の一言のターンが閉じたか。 */
  private ackDone = false;
  private fillerTimer: NodeJS.Timeout | null = null;
  private fillerSent = false;
  private floorTimer: NodeJS.Timeout | null = null;
  private compareShown = false;
  private persisted = false;
  private disposed = false;

  constructor(
    private readonly host: CoachHost,
    private readonly image: LearnerImage,
    options: Partial<RetellOptions> & Pick<RetellOptions, "analyst">,
  ) {
    this.opts = { ...DEFAULT_RETELL_OPTIONS, ...options };
  }

  get state(): RetellPhase {
    return this.phase;
  }

  onReady(): void {
    // 観点は挨拶の前から見せる。先生は挨拶の中でこれを指して話す。
    this.showBoard();
  }

  teacherSaid(): void {}

  learnerSaid(text: string, done: boolean): void {
    if (done && text.trim()) this.lines.push(text.trim());
  }

  /** 「話す」。段階によっては、先生を待たずに始めた合図でもある。 */
  learnerSpeechStart(): void {
    if (this.disposed) return;
    this.lines = [];
    switch (this.phase) {
      case "greeting":
        // 挨拶を待たずに話し始めた。1回目として扱う。
        this.setPhase("telling");
        break;
      case "reviewing":
        // 講評の途中で話し始めた。話し直しとして扱う。
        this.toRetelling();
        break;
      case "retold":
        this.toAnswering();
        break;
      default:
        break;
    }
  }

  /** 「送信」。1回目・2回目・答えの区切り。 */
  learnerSpeechEnd(take: Take | null): void {
    if (this.disposed) return;
    switch (this.phase) {
      case "telling": {
        if (!this.acceptable(take)) return;
        this.first = this.record(take);
        this.ackDone = false;
        this.setPhase("analyzing");
        this.runTellingAnalysis(this.first);
        break;
      }
      case "retelling": {
        if (!this.acceptable(take)) return;
        this.second = this.record(take);
        this.setPhase("retold");
        this.runRetellAnalysis(this.second);
        break;
      }
      case "answering":
        this.answer = this.lines.join(" ");
        this.setPhase("closing");
        break;
      default:
        // 整理待ち・講評中などの送信。先生は答えるが、段階は動かさない。
        break;
    }
  }

  teacherTurnDone(): void {
    if (this.disposed) return;
    switch (this.phase) {
      case "greeting":
        this.setPhase("telling");
        break;
      case "analyzing":
        // 「聞きました、少し待って」の一言が終わった。整理が来ていれば講評へ。
        this.ackDone = true;
        if (!this.tryStartReview()) this.armFiller();
        break;
      case "reviewing":
        this.toRetelling();
        break;
      case "retold":
        this.toAnswering();
        break;
      case "closing":
        this.finish();
        break;
      default:
        // telling / retelling / answering: ヒントの番が終わっただけ。finished: 何もしない。
        break;
    }
  }

  onControl(action: string): void {
    if (this.disposed || action !== "hint") return;
    if (!HINT_PHASES.has(this.phase)) {
      this.host.log(`ヒントはいまは出さない(${this.phase})`);
      return;
    }
    this.hints += 1;
    this.host.log(`ヒント ${this.hints} 回目(${this.phase})`);
    this.host.nudge(RETELL_HINT_NUDGE, "now");
  }

  onToolCall(name: string, args: Record<string, unknown>): ToolReply {
    const outcome = dispatchToolCall(name, args);
    if (!outcome) {
      this.host.log(`不明なツール: ${name} ${JSON.stringify(args).slice(0, 120)}`);
      return { response: { shown: false, error: "unknown tool or invalid arguments" }, scheduling: "SILENT" };
    }
    if (outcome.ui) {
      this.host.log(`ツール → ${outcome.ui.widget} ${JSON.stringify(outcome.ui.props).slice(0, 120)}`);
      this.host.showUi(outcome.ui);
    }
    return outcome.reply;
  }

  /** このモードでは無音の声かけをしない。学習者が考えている時間を奪わないため。挨拶が来ないときだけ既定。 */
  silenceNudge(): string | null | undefined {
    return this.phase === "greeting" ? undefined : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFiller();
    if (this.floorTimer) clearTimeout(this.floorTimer);
    this.floorTimer = null;
    this.persist();
  }

  /** 比較(retell_compare)。1回目しか無ければ2回目は空。 */
  compare(): RetellCompareProps {
    if (!this.first) throw new Error("1回目がまだ無い");
    const props: RetellCompareProps = {
      first: this.takeSummary(this.first, this.firstAnalysis?.transcript, this.firstAnalysis?.points, this.firstAnalysis?.assessment),
      improvements: this.improvementsUsed(),
    };
    if (this.second) {
      props.second = this.takeSummary(this.second, this.secondAnalysis?.transcript, this.secondAnalysis?.points, this.secondAnalysis?.assessment);
    }
    if (this.secondAnalysis?.comment) props.comment = this.secondAnalysis.comment;
    if (this.firstAnalysis?.teaching) props.teaching = this.firstAnalysis.teaching;
    return props;
  }

  /** 記録の1行。 */
  row(): RetellResultRow {
    const row: RetellResultRow = {
      kind: "retell",
      at: new Date(this.opts.clock()).toISOString(),
      prompts: retellPromptLines(),
      improvements: this.improvementsUsed(),
      finished: this.phase === "finished",
    };
    if (this.first) row.first = this.takeSummary(this.first, this.firstAnalysis?.transcript, this.firstAnalysis?.points, this.firstAnalysis?.assessment);
    if (this.second) {
      row.second = this.takeSummary(this.second, this.secondAnalysis?.transcript, this.secondAnalysis?.points, this.secondAnalysis?.assessment);
    }
    if (this.firstAnalysis) row.question = this.firstAnalysis.question;
    if (this.answer) row.answer = this.answer;
    if (this.secondAnalysis?.comment) row.comment = this.secondAnalysis.comment;
    if (this.firstAnalysis?.teaching) row.teaching = this.firstAnalysis.teaching;
    return row;
  }

  // ── 段階 ────────────────────────────────────────────────────────────────────

  private setPhase(next: RetellPhase, note?: string): void {
    this.phase = next;
    this.host.log(`段階 → ${next}`);
    this.showBoard(note);
  }

  private showBoard(note?: string): void {
    const props: RetellBoardProps = { phase: this.phase, title: RETELL_TITLES[this.phase], lines: this.boardLines() };
    if (note) props.note = note;
    this.host.showUi({ widget: "retell_board", props });
  }

  private boardLines(): string[] {
    switch (this.phase) {
      case "retelling":
      case "retold": {
        const keywords = this.firstAnalysis?.keywords ?? [];
        // お手本の英文は出さない。キーワードが無ければ観点のまま。
        return keywords.length > 0 ? keywords : retellPromptLines();
      }
      case "answering":
      case "closing":
        return [this.question()];
      case "finished":
        return [];
      default:
        return retellPromptLines();
    }
  }

  private question(): string {
    return this.firstAnalysis?.question ?? DEFAULT_RETELL_QUESTION;
  }

  private acceptable(take: Take | null): take is Take {
    if (!take) {
      this.host.log("送信に録音が付いていない(captureSpeech が無い)— 段階を進めない");
      return false;
    }
    if (take.durationMs < this.opts.minTakeMs) {
      this.host.log(`短すぎる送信(${Math.round(take.durationMs)}ms)— 押し間違いと見て段階を進めない`);
      return false;
    }
    return true;
  }

  /** いまの発話を1回分として確定する。ヒントの数はここで回に付き、段階の分は 0 に戻る。 */
  private record(take: Take): TakeRecord {
    const rec: TakeRecord = { take, lines: this.lines, hints: this.hints };
    this.hints = 0;
    return rec;
  }

  // ── 1回目 → 整理 → 講評 ──────────────────────────────────────────────────────

  private runTellingAnalysis(rec: TakeRecord): void {
    const startedAt = this.opts.clock();
    this.host.log(
      `Flash に1回目の整理を頼む(${(rec.take.durationMs / 1000).toFixed(1)}s${rec.take.truncated ? "、末尾を切った" : ""})`,
    );
    void this.opts.analyst
      .analyzeTelling({
        image: this.image,
        take: rec.take,
        transcriptHint: rec.lines.join(" "),
        prompts: retellPromptLines(),
      })
      .then((analysis) => {
        if (this.disposed) return;
        this.firstAnalysis = analysis;
        this.host.log(
          `整理できた(${((this.opts.clock() - startedAt) / 1000).toFixed(1)}s): 要点 ${analysis.points.length}、` +
            `改善点 ${analysis.improvements.length}、キーワード ${analysis.keywords.length}`,
        );
        this.tryStartReview();
      })
      .catch((err: unknown) => {
        if (this.disposed) return;
        this.firstFailed = true;
        this.host.log(`整理に失敗 — 講評は先生に任せる: ${err instanceof Error ? err.message : String(err)}`);
        this.tryStartReview();
      });
  }

  /** 整理(または失敗)と、先生の一言の両方が揃ったら講評へ。進めたら true。 */
  private tryStartReview(): boolean {
    if (this.phase !== "analyzing" || !this.first) return false;
    if (!this.firstAnalysis && !this.firstFailed) return false;
    // 一言の途中。ターンが閉じたときにまた呼ばれる。
    if (this.host.teacherSpeaking()) return false;
    const sinceSend = this.opts.clock() - this.first.take.endedAt;
    if (!this.ackDone && sinceSend < this.opts.reviewFloorMs) {
      // 送信の直後で、先生の一言がまだ始まっていない。いま差し込むとその生成に割り込む。
      if (!this.floorTimer) {
        this.floorTimer = setTimeout(() => {
          this.floorTimer = null;
          this.tryStartReview();
        }, this.opts.reviewFloorMs - sinceSend);
      }
      return false;
    }
    this.startReview();
    return true;
  }

  private startReview(): void {
    this.clearFiller();
    this.setPhase("reviewing");
    if (this.firstAnalysis) {
      const props: RetellReviewProps = { improvements: this.firstAnalysis.improvements };
      if (this.firstAnalysis.points.length > 0) props.points = this.firstAnalysis.points;
      if (this.firstAnalysis.assessment) props.assessment = this.firstAnalysis.assessment;
      if (this.firstAnalysis.teaching) props.teaching = this.firstAnalysis.teaching;
      this.host.showUi({ widget: "retell_review", props });
      this.host.nudge(retellReviewNudge(this.firstAnalysis), "now");
    } else {
      this.host.nudge(RETELL_FALLBACK_REVIEW_NUDGE, "now");
    }
  }

  private armFiller(): void {
    if (this.fillerSent || this.fillerTimer) return;
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      if (this.disposed || this.phase !== "analyzing" || this.fillerSent) return;
      this.fillerSent = true;
      this.host.log("整理が長引いている — つなぎの一言を頼む");
      this.host.nudge(RETELL_FILLER_NUDGE, "now");
    }, this.opts.fillerMs);
  }

  private clearFiller(): void {
    if (this.fillerTimer) clearTimeout(this.fillerTimer);
    this.fillerTimer = null;
  }

  // ── 2回目 → 追加の質問 → 締め ────────────────────────────────────────────────

  private toRetelling(): void {
    this.hints = 0;
    // 改善点のカードを下げる。お手本の英文は隠し、画像とキーワードだけを残す。
    this.host.showUi({ widget: "hide", props: {} });
    this.setPhase("retelling", this.firstAnalysis ? undefined : "キーワードは作れなかったので、観点のまま");
    this.host.nudge(retellRetellNudge(this.question()), "next-turn");
  }

  private runRetellAnalysis(rec: TakeRecord): void {
    const first = this.firstAnalysis;
    if (!first) {
      this.host.log("1回目の整理が無いので、2回目の振り返りは頼まない");
      return;
    }
    const startedAt = this.opts.clock();
    this.host.log(`Flash に2回目の振り返りを頼む(${(rec.take.durationMs / 1000).toFixed(1)}s)`);
    void this.opts.analyst
      .analyzeRetell({ image: this.image, take: rec.take, transcriptHint: rec.lines.join(" "), first })
      .then((analysis) => {
        if (this.disposed) return;
        this.secondAnalysis = analysis;
        this.host.log(
          `振り返りできた(${((this.opts.clock() - startedAt) / 1000).toFixed(1)}s): 要点 ${analysis.points.length}、` +
            `使えた言い方 ${analysis.used.length}`,
        );
        if (this.phase === "finished") this.showCompare();
      })
      .catch((err: unknown) => {
        if (this.disposed) return;
        this.secondFailed = true;
        this.host.log(`振り返りに失敗 — 字幕で比較する: ${err instanceof Error ? err.message : String(err)}`);
        if (this.phase === "finished") this.showCompare();
      });
  }

  private toAnswering(): void {
    this.hints = 0;
    this.setPhase("answering");
    this.host.nudge(RETELL_ANSWER_NUDGE, "next-turn");
  }

  private finish(): void {
    this.setPhase("finished");
    // 振り返りが済んでいれば比較を出す。まだなら届いたとき(runRetellAnalysis)に。
    const settled = this.secondAnalysis !== null || this.secondFailed || !this.second || !this.firstAnalysis;
    if (settled) this.showCompare();
  }

  private showCompare(): void {
    if (this.compareShown || !this.first) return;
    this.compareShown = true;
    this.host.showUi({ widget: "retell_compare", props: this.compare() });
    this.persist();
  }

  // ── まとめと記録 ────────────────────────────────────────────────────────────

  private takeSummary(rec: TakeRecord, transcript: string | undefined, points: string[] | undefined, assessment?: AssessmentItem[]): RetellTake {
    const text = transcript || rec.lines.join(" ");
    return {
      transcript: text,
      seconds: Math.round(rec.take.durationMs / 1000),
      words: countWords(text),
      points: points ?? [],
      hints: rec.hints,
      ...(assessment ? { assessment } : {}),
    };
  }

  private improvementsUsed(): RetellCompareProps["improvements"] {
    const improvements = this.firstAnalysis?.improvements ?? [];
    // 分析がないときは成功/失敗を決めず保留にする。
    if (!this.second || !this.secondAnalysis) return improvements.map((imp) => ({ ...imp }));
    const transcript = this.secondAnalysis?.transcript || this.second.lines.join(" ");
    const used = this.secondAnalysis?.used ?? [];
    return improvements.map((imp) => ({ ...imp, used: usedInRetell(imp.better, transcript, used) }));
  }

  private persist(): void {
    if (this.persisted || !this.first) return;
    this.persisted = true;
    this.opts.onOutcome?.(this.row());
  }
}

/** 英語の語数。日本語は数えない(英語で言えた量を見たい)。 */
export function countWords(text: string): number {
  const key = normalizeTerm(text);
  return key ? key.split(" ").length : 0;
}

/**
 * 改善点を使えたか。意味を確認した Flash の判定か、表現全体の一致のみを採用する。
 * 単語の重なりだけでは、時制・前置詞・否定などの誤りを見逃すため成功扱いにしない。
 */
export function usedInRetell(better: string, transcript: string, flashUsed?: readonly string[]): boolean {
  const key = normalizeTerm(better);
  if (!key) return false;
  // 分析で「使えていない」と判定されたとき、文字一致で上書きしない。
  if (flashUsed) return flashUsed.some((u) => normalizeTerm(u) === key);
  if (mentions(transcript, better)) return true;
  return false;
}
