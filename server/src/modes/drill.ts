/**
 * 瞬間英作文のコーチ。日本語の文を1つ出し、学習者がすぐ英語で言い、先生が判定する。
 *
 * 進行はここが持つ。問題の一覧をモデルに丸ごと渡すと、飛ばす・作る・順番を忘れる
 * が起きる。だから1問ずつ [進行] で渡し、判定はツール(drill_result)で受け取り、
 * 先生のターンが閉じたら次を渡す。
 *
 * 1問の流れ:
 *   出題(prompting)     こちらがカードを出し、先生に読み上げを頼む
 *   回答待ち(answering)  先生が読み終えた時点から時計が動く。制限時間でヒント
 *   判定(judging)       先生が drill_result を呼び、答えのカードが出る。ターンが閉じたら次へ
 *
 * 先生が報告を忘れて止まったときは、無音の見張りが silenceNudge() を呼ぶので
 * そこで催促する。判定の後に止まったときは、そこで次へ進む。
 */

import type { DrillAnswerProps, DrillVerdict, SummaryLine, SummaryProps, TeachingNotes } from "../../../shared/messages";
import { teachingFromTool } from "../feedback";
import type { ToolReply } from "../gemini";
import {
  DRILL_REPORT_REMINDER,
  drillFinishNudge,
  drillGiveUpNudge,
  drillHintNudge,
  drillPromptNudge,
} from "../prompts";
import type { DrillResultRow } from "../results";
import type { DrillItem, Scene } from "../scenes";
import type { Coach, CoachHost } from "./types";
import { capture, restore, type CoachCheckpoint } from "./checkpoint";

const CHECKPOINT_KEYS = ["queue", "total", "index", "round", "phase", "current", "windowStart",
  "firstAnswerAt", "said", "outcomes", "misses"] as const;

export interface DrillOptions {
  /** 1問の制限時間。省くとシーンの drillLimitMs。 */
  limitMs?: number;
  /** 出題順を混ぜる。 */
  shuffle: boolean;
  /** 間違えた問題を最後にもう一周する。 */
  repeatMissed: boolean;
  clock: () => number;
  random: () => number;
  /** 前回までの直近の判定。間違えた問題を先に出す。 */
  lastVerdicts?: ReadonlyMap<string, DrillVerdict>;
  /** 1問ごとの記録。 */
  onOutcome?: (row: DrillResultRow) => void;
}

export const DEFAULT_DRILL_OPTIONS: DrillOptions = {
  shuffle: true,
  repeatMissed: true,
  clock: Date.now,
  random: Math.random,
};

const VERDICTS: readonly DrillVerdict[] = ["correct", "close", "wrong", "skipped"];

export const VERDICT_LABEL: Record<DrillVerdict, string> = {
  correct: "正解",
  close: "惜しい",
  wrong: "不正解",
  skipped: "スキップ",
};

export type DrillPhase = "greeting" | "prompting" | "answering" | "judging" | "finished";

export interface DrillOutcome {
  round: number;
  item: DrillItem;
  verdict: DrillVerdict;
  said?: string;
  note?: string;
  latencyMs?: number;
  teaching?: TeachingNotes;
}

export class DrillRunner implements Coach {
  checkpoint(): CoachCheckpoint { return capture(this, "drill", CHECKPOINT_KEYS); }
  restore(checkpoint: CoachCheckpoint): boolean {
    if (!restore(this, checkpoint, "drill", CHECKPOINT_KEYS)) return false;
    if (this.phase === "prompting") this.phase = "answering";
    this.windowStart = this.opts.clock();
    this.firstAnswerAt = null;
    this.said = "";
    return true;
  }
  private readonly opts: DrillOptions;
  private readonly limitMs: number;
  private queue: DrillItem[];
  private total: number;
  private index = 0;
  private round = 1;
  private phase: DrillPhase = "greeting";
  private current: DrillItem | null = null;
  /** 答えの時計の起点(先生が読み終えた時刻)。 */
  private windowStart: number | null = null;
  /** 学習者が答え始めた時刻。 */
  private firstAnswerAt: number | null = null;
  /** 学習者の発話(文字起こし、そのターンの全文)。 */
  private said = "";
  private hintTimer: NodeJS.Timeout | null = null;
  private readonly outcomes: DrillOutcome[] = [];
  private misses: DrillItem[] = [];
  private disposed = false;

  constructor(
    private readonly host: CoachHost,
    private readonly scene: Scene,
    options: Partial<DrillOptions> = {},
  ) {
    this.opts = { ...DEFAULT_DRILL_OPTIONS, ...options };
    this.limitMs = this.opts.limitMs ?? scene.drillLimitMs;
    this.queue = orderDrills(scene.drills, this.opts);
    this.total = this.queue.length;
  }

  get state(): DrillPhase {
    return this.phase;
  }

  get results(): readonly DrillOutcome[] {
    return this.outcomes;
  }

  teacherSaid(): void {}

  learnerSpeaking(): void {
    this.noteAnswerStart();
  }

  learnerSaid(text: string, _done: boolean): void {
    if (this.phase !== "prompting" && this.phase !== "answering") return;
    this.noteAnswerStart();
    if (text) this.said = text;
  }

  teacherTurnDone(): void {
    if (this.disposed) return;
    switch (this.phase) {
      case "greeting":
        // 挨拶が終わった。最初の問題。
        this.advance();
        break;
      case "prompting":
        // 読み終えた。ここから時計が動く。
        this.openWindow();
        break;
      case "judging":
        // 講評が終わった。次へ。
        this.advance();
        break;
      default:
        // answering: ヒントの番が終わっただけ。finished: 何もしない。
        break;
    }
  }

  onToolCall(name: string, args: Record<string, unknown>): ToolReply {
    if (name !== "drill_result") {
      this.host.log(`不明なツール: ${name} ${JSON.stringify(args).slice(0, 120)}`);
      return { response: { shown: false, error: "unknown tool" }, scheduling: "SILENT" };
    }
    if (!this.current || (this.phase !== "prompting" && this.phase !== "answering")) {
      return { response: { recorded: false, reason: "no prompt is waiting for a verdict" }, scheduling: "SILENT" };
    }
    const verdict = parseVerdict(args.verdict);
    if (!verdict) {
      return {
        response: { recorded: false, reason: `verdict must be one of ${VERDICTS.join(", ")}` },
        scheduling: "SILENT",
      };
    }
    const said = typeof args.said === "string" && args.said.trim() ? args.said.trim().slice(0, 200) : undefined;
    const note = typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, 160) : undefined;
    this.record(verdict, said, note, teachingFromTool(args));
    this.phase = "judging";
    // 報告が先生のターンの後に来た(もう喋っていない)なら、待つものが無い。すぐ次へ。
    if (!this.host.teacherSpeaking()) this.advance();
    return { response: { recorded: true, remaining: this.queue.length }, scheduling: "SILENT" };
  }

  onControl(action: string): void {
    if (action !== "skip" || !this.current) return;
    if (this.phase !== "prompting" && this.phase !== "answering") return;
    const item = this.current;
    this.host.log(`スキップ: "${item.ja}"`);
    this.record("skipped", undefined, "スキップ");
    this.phase = "judging";
    this.advance(`学習者が前の問題をスキップした。模範解答 "${item.en}" を一度だけ言ってから、`);
  }

  /** 無音が続いた。段階に応じて、催促するか、正解を言わせるか、自分で進む。 */
  silenceNudge(): string | null | undefined {
    switch (this.phase) {
      case "answering":
        // 答えたのに判定が来ない → 催促。答えていない → 正解を言わせて skipped。
        if (this.firstAnswerAt !== null || this.said) return DRILL_REPORT_REMINDER;
        return this.current ? drillGiveUpNudge(this.current) : undefined;
      case "prompting":
        // 読み上げのターンが閉じないまま無音。時計だけ動かして、既定の声かけ。
        this.openWindow();
        return undefined;
      case "judging":
        // 判定の後に止まった。次へ。
        this.advance();
        return null;
      default:
        return undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearHint();
  }

  /** まとめ(summary ウィジェット)。 */
  summary(): SummaryProps {
    const tone = (v: DrillVerdict): SummaryLine["tone"] =>
      v === "correct" ? "good" : v === "close" ? "warn" : v === "wrong" ? "bad" : "muted";
    const lines: SummaryLine[] = this.outcomes.map((o) => ({
      label: `${o.round > 1 ? "再 " : ""}${o.item.ja}`,
      value:
        VERDICT_LABEL[o.verdict] +
        (o.latencyMs !== undefined ? ` · ${(o.latencyMs / 1000).toFixed(1)}s` : "") +
        ` · ${o.item.en}`,
      tone: tone(o.verdict),
    }));
    const correct = this.outcomes.filter((o) => o.verdict === "correct").length;
    const avg = this.averageLatencySec();
    return {
      title: `${this.scene.title} — 瞬間英作文の結果`,
      lines,
      footer: `正解 ${correct} / ${this.outcomes.length}${avg === null ? "" : ` · 平均反応 ${avg.toFixed(1)} 秒`}`,
    };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private noteAnswerStart(): void {
    if (this.phase !== "prompting" && this.phase !== "answering") return;
    if (this.firstAnswerAt !== null) return;
    const now = this.opts.clock();
    this.firstAnswerAt = now;
    if (this.phase === "prompting") {
      // 読み終える前に答え始めた。時計は今から。
      this.phase = "answering";
      this.windowStart = now;
    }
    // 答え始めたのならヒントは要らない。
    this.clearHint();
  }

  private openWindow(): void {
    this.phase = "answering";
    this.windowStart = this.opts.clock();
    this.startHint();
  }

  private startHint(): void {
    this.clearHint();
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      if (this.disposed || this.phase !== "answering" || this.firstAnswerAt !== null || !this.current) return;
      this.host.log("制限時間 — ヒントを頼む");
      this.host.nudge(drillHintNudge(this.current), "now");
    }, this.limitMs);
  }

  private clearHint(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
  }

  private record(verdict: DrillVerdict, said: string | undefined, note: string | undefined, teaching?: TeachingNotes): void {
    const item = this.current;
    if (!item) return;
    this.clearHint();
    const latencyMs =
      this.firstAnswerAt !== null && this.windowStart !== null
        ? Math.max(0, this.firstAnswerAt - this.windowStart)
        : undefined;
    const spoken = said ?? (this.said || undefined);

    const outcome: DrillOutcome = { round: this.round, item, verdict };
    if (spoken) outcome.said = spoken;
    if (note) outcome.note = note;
    if (latencyMs !== undefined) outcome.latencyMs = latencyMs;
    if (teaching) outcome.teaching = teaching;
    this.outcomes.push(outcome);
    if (verdict !== "correct") this.misses.push(item);

    const props: DrillAnswerProps = { ja: item.ja, answer: item.en, verdict };
    if (spoken) props.said = spoken;
    if (note) props.note = note;
    if (latencyMs !== undefined) props.latencyMs = latencyMs;
    if (teaching) props.teaching = teaching;
    this.host.showUi({ widget: "drill_answer", props });
    this.host.log(
      `判定 ${verdict}: "${item.en}"${latencyMs !== undefined ? ` (${(latencyMs / 1000).toFixed(1)}s)` : ""}`,
    );

    const row: DrillResultRow = {
      kind: "drill",
      at: new Date(this.opts.clock()).toISOString(),
      scene: this.scene.id,
      round: this.round,
      ja: item.ja,
      en: item.en,
      verdict,
    };
    if (spoken) row.said = spoken;
    if (note) row.note = note;
    if (latencyMs !== undefined) row.latencyMs = latencyMs;
    if (teaching) row.teaching = teaching;
    this.opts.onOutcome?.(row);
  }

  /** 次の問題を出す。無ければ、間違えた問題をもう一周するか、終える。 */
  private advance(prefix = ""): void {
    let next = this.queue.shift();
    if (!next && this.opts.repeatMissed && this.round === 1 && this.misses.length > 0) {
      this.round = 2;
      this.queue = this.misses;
      this.misses = [];
      this.index = 0;
      this.total = this.queue.length;
      next = this.queue.shift();
      prefix += "ここから、間違えた問題をもう一度出す。そう一言伝えてから、";
    }
    if (!next) {
      this.finish();
      return;
    }
    this.current = next;
    this.index += 1;
    this.phase = "prompting";
    this.windowStart = null;
    this.firstAnswerAt = null;
    this.said = "";
    this.host.showUi({
      widget: "drill_prompt",
      props: { index: this.index, total: this.total, ja: next.ja, limitMs: this.limitMs },
    });
    this.host.nudge(prefix + drillPromptNudge(next, this.index, this.total, this.scene.promptVoice), "now");
  }

  private finish(): void {
    this.phase = "finished";
    this.current = null;
    this.clearHint();
    const correct = this.outcomes.filter((o) => o.verdict === "correct").length;
    // 最終的に正解できなかった文(2周目で直せたものは除く)。
    const lastByEn = new Map<string, DrillVerdict>();
    for (const o of this.outcomes) lastByEn.set(o.item.en, o.verdict);
    const missed = [...lastByEn].filter(([, v]) => v !== "correct").map(([en]) => en);
    this.host.log(`瞬間英作文 終了: 正解 ${correct}/${this.outcomes.length}`);
    this.host.showUi({ widget: "summary", props: this.summary() });
    this.host.nudge(drillFinishNudge(correct, this.outcomes.length, this.averageLatencySec(), missed), "now");
  }

  private averageLatencySec(): number | null {
    const values = this.outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== undefined);
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length / 1000;
  }
}

/** モデルが言った verdict を型に。知らない値は undefined。 */
export function parseVerdict(v: unknown): DrillVerdict | undefined {
  if (typeof v !== "string") return undefined;
  const key = v.trim().toLowerCase();
  return VERDICTS.find((x) => x === key);
}

/** 出題順。前回間違えた問題を先に、そのあと残り。指定があればそれぞれ混ぜる。 */
export function orderDrills(
  items: readonly DrillItem[],
  opts: Pick<DrillOptions, "shuffle" | "random" | "lastVerdicts">,
): DrillItem[] {
  const weak: DrillItem[] = [];
  const rest: DrillItem[] = [];
  for (const item of items) {
    const last = opts.lastVerdicts?.get(item.en);
    (last !== undefined && last !== "correct" ? weak : rest).push(item);
  }
  const arrange = (list: DrillItem[]) => (opts.shuffle ? shuffled(list, opts.random) : list);
  return [...arrange(weak), ...arrange(rest)];
}

function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
