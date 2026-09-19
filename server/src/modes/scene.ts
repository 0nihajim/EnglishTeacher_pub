/**
 * シーン会話(正解つき)のコーチ。
 *
 * 先生はシーンを演じながら、今日の表現を使う機会を作る。ここが持つのは表現ごとの
 * 状態だけで、判定は2系統ある:
 *  - 学習者の文字起こしをこちらで照合する(heard)。モデルに頼らないので取りこぼさない。
 *  - 先生が report_target で伝える(used_well / used_with_error / modeled)。使い方の
 *    良し悪しは音声を聞いている先生のほうが分かる。
 * 状態は強い方にしか進まない。表示は targets の帯(常時)と、show_progress で
 * 出すまとめ(舞台をまるごと使う)。
 *
 * 舵取りは next-turn の nudge で行う。学習者の次の発話と一緒に届くので、
 * 学習者の番を奪わない。
 */

import type { RecastProps, SummaryLine, SummaryProps, TargetStatusKind, TargetsProps } from "../../../shared/messages";
import type { ToolReply } from "../gemini";
import { SCENE_ALL_DONE_NUDGE, sceneSteerNudge } from "../prompts";
import type { SceneResultRow } from "../results";
import type { Scene, SceneTarget } from "../scenes";
import { dispatchToolCall } from "../tools";
import { mentions, normalizeTerm } from "./match";
import type { Coach, CoachHost } from "./types";
import { capture, restore, type CoachCheckpoint } from "./checkpoint";

const CHECKPOINT_KEYS = ["states", "teacherTurns", "allDoneNudged"] as const;

/** 状態の強さ。弱い方へは戻らない。 */
const RANK: Record<TargetStatusKind, number> = {
  unused: 0,
  modeled: 1,
  heard: 2,
  used_with_error: 3,
  used_well: 4,
};

export const STATUS_LABEL: Record<TargetStatusKind, string> = {
  unused: "まだ",
  modeled: "先生が示した",
  heard: "口にした",
  used_with_error: "使えた(要修正)",
  used_well: "使えた",
};

/** report_target の outcome → 状態。 */
const OUTCOMES: Record<string, TargetStatusKind> = {
  used_well: "used_well",
  used_with_error: "used_with_error",
  modeled: "modeled",
};

export interface SceneOptions {
  /** 先生のターンがこの回数終わるごとに、未使用の表現の機会を作るよう頼む。 */
  steerEvery: number;
  clock: () => number;
  /** セッション終了時の記録。 */
  onOutcome?: (rows: SceneResultRow[]) => void;
  onFeedback?: (feedback: RecastProps) => void;
}

export const DEFAULT_SCENE_OPTIONS: SceneOptions = { steerEvery: 3, clock: Date.now };

interface TargetState {
  def: SceneTarget;
  status: TargetStatusKind;
  /** 学習者がその表現を含めて言った文(直近)。 */
  said?: string;
  /** 先生の一言(report_target の note)。 */
  note?: string;
}

export class SceneCoach implements Coach {
  checkpoint(): CoachCheckpoint { return capture(this, "scene", CHECKPOINT_KEYS); }
  restore(checkpoint: CoachCheckpoint): boolean { return restore(this, checkpoint, "scene", CHECKPOINT_KEYS); }
  private readonly opts: SceneOptions;
  private readonly states: TargetState[];
  private teacherTurns = 0;
  private allDoneNudged = false;
  private disposed = false;

  constructor(
    private readonly host: CoachHost,
    private readonly scene: Scene,
    options: Partial<SceneOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SCENE_OPTIONS, ...options };
    this.states = scene.targets.map((def) => ({ def, status: "unused" }));
  }

  /** 表現ごとの状態(読み取り専用)。 */
  get targets(): readonly { term: string; status: TargetStatusKind }[] {
    return this.states.map((s) => ({ term: s.def.term, status: s.status }));
  }

  onReady(): void {
    this.showTargets();
  }

  /** 学習者の発話。表現が入っていれば heard に上げる(途中経過でも見る)。 */
  learnerSaid(text: string, _done: boolean): void {
    if (this.disposed) return;
    let changed = false;
    for (const s of this.states) {
      if (!mentions(text, s.def.term, s.def.variants)) continue;
      s.said = text;
      if (RANK[s.status] < RANK.heard) {
        s.status = "heard";
        changed = true;
        this.host.log(`学習者が "${s.def.term}" を口にした`);
      }
    }
    if (changed) this.showTargets();
  }

  /** 先生の発話。まだ誰も口にしていない表現を先生が言ったら modeled。 */
  teacherSaid(text: string): void {
    if (this.disposed) return;
    let changed = false;
    for (const s of this.states) {
      if (s.status !== "unused" || !mentions(text, s.def.term, s.def.variants)) continue;
      s.status = "modeled";
      changed = true;
    }
    if (changed) this.showTargets();
  }

  /**
   * 先生のターンが閉じた。一定回数ごとに、まだ出ていない表現の機会を作るよう頼む。
   * 全部出たら一度だけ、締めてよいと伝える。
   */
  teacherTurnDone(): void {
    if (this.disposed) return;
    this.teacherTurns += 1;
    const remaining = this.states.filter((s) => s.status !== "used_well");
    if (remaining.length === 0) {
      if (!this.allDoneNudged) {
        this.allDoneNudged = true;
        this.host.log("今日の表現をすべて正しく使えた");
        this.host.nudge(SCENE_ALL_DONE_NUDGE, "next-turn");
      }
      return;
    }
    if (this.teacherTurns % this.opts.steerEvery !== 0) return;
    // 先生も口にしていないものを優先し、多くても2つ。全部渡すと先生が羅列し始める。
    const pick = [...remaining]
      .sort((a, b) => RANK[a.status] - RANK[b.status])
      .slice(0, 2)
      .map((s) => s.def.term);
    this.host.log(`舵取り: ${pick.join(" / ")}`);
    this.host.nudge(sceneSteerNudge(pick), "next-turn");
  }

  onToolCall(name: string, args: Record<string, unknown>): ToolReply {
    if (name === "report_target") return this.reportTarget(args);
    if (name === "show_progress") {
      // 途中経過は「表現ごとの状態」。一覧はこちらが持っているので、モデルは
      // 見出しも中身も渡せない(取り違え・作り出しが構造として起きない)。
      this.host.log("ツール → summary(表現の状態)");
      this.host.showUi({ widget: "summary", props: this.summary() });
      return { response: { shown: true, targets: this.targets }, scheduling: "WHEN_IDLE" };
    }
    const outcome = dispatchToolCall(name, args);
    if (!outcome) {
      this.host.log(`不明なツール: ${name} ${JSON.stringify(args).slice(0, 120)}`);
      return {
        response: { shown: false, error: "unknown tool or invalid arguments" },
        scheduling: "SILENT",
      };
    }
    if (outcome.ui) {
      this.host.log(`ツール → ${outcome.ui.widget} ${JSON.stringify(outcome.ui.props).slice(0, 120)}`);
      this.host.showUi(outcome.ui);
      if (outcome.ui.widget === "recast") this.opts.onFeedback?.(outcome.ui.props);
    }
    return outcome.reply;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opts.onOutcome?.(this.rows());
  }

  /** まとめ(summary ウィジェット)。 */
  summary(): SummaryProps {
    const tone = (status: TargetStatusKind): SummaryLine["tone"] => {
      if (status === "used_well") return "good";
      if (status === "used_with_error" || status === "heard") return "warn";
      if (status === "modeled") return "bad";
      return "muted";
    };
    const lines: SummaryLine[] = this.states.map((s) => ({
      label: s.def.term,
      value: s.note ? `${STATUS_LABEL[s.status]} · ${s.note}` : STATUS_LABEL[s.status],
      tone: tone(s.status),
    }));
    const used = this.states.filter((s) => s.status === "used_well").length;
    const attempted = this.states.filter((s) => s.status === "heard" || s.status === "used_with_error").length;
    return {
      title: `${this.scene.title} — 今日の表現`,
      lines,
      footer: `正しく使えた ${used} / ${this.states.length} · 要確認・要修正 ${attempted}`,
    };
  }

  private reportTarget(args: Record<string, unknown>): ToolReply {
    const term = typeof args.term === "string" ? args.term : "";
    const status = typeof args.outcome === "string" ? OUTCOMES[args.outcome.trim().toLowerCase()] : undefined;
    const state = this.find(term);
    if (!state || !status) {
      this.host.log(`report_target を断った: ${JSON.stringify(args).slice(0, 120)}`);
      return {
        response: {
          recorded: false,
          reason: state
            ? "outcome must be used_well, used_with_error or modeled"
            : "not one of today's target expressions",
        },
        scheduling: "SILENT",
      };
    }
    if (typeof args.note === "string" && args.note.trim()) state.note = args.note.trim().slice(0, 160);
    if (RANK[status] > RANK[state.status]) state.status = status;
    this.host.log(`先生の判定 "${state.def.term}" → ${state.status}`);
    this.showTargets();
    return { response: { recorded: true, status: state.status }, scheduling: "SILENT" };
  }

  /** モデルが言った表現名から状態を引く。完全一致 → 含む、の順。 */
  private find(term: string): TargetState | undefined {
    const key = normalizeTerm(term);
    if (!key) return undefined;
    return (
      this.states.find((s) => [s.def.term, ...s.def.variants].some((t) => normalizeTerm(t) === key)) ??
      this.states.find((s) => mentions(term, s.def.term, s.def.variants) || mentions(s.def.term, term))
    );
  }

  private showTargets(): void {
    const props: TargetsProps = {
      title: this.scene.title,
      targets: this.states.map((s) => ({ term: s.def.term, meaning: s.def.meaning, status: s.status })),
    };
    this.host.showUi({ widget: "targets", props });
  }

  private rows(): SceneResultRow[] {
    const at = new Date(this.opts.clock()).toISOString();
    return this.states.map((s) => {
      const row: SceneResultRow = { kind: "scene", at, scene: this.scene.id, term: s.def.term, status: s.status };
      if (s.said) row.said = s.said;
      if (s.note) row.note = s.note;
      return row;
    });
  }
}
