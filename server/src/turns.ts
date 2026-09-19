/**
 * 文字起こしの断片からターンを組み立てる。
 *
 * 元デモの turns.ts は GPT-Live v3 がターン境界を一切くれないので、セッション
 * タイムラインと壁時計の2つのギャップ時計で境界を推測していた。Gemini は
 * turnComplete を明示的に送るため、先生側の境界は推測が要らない。
 * 残った推測は学習者側だけで、そこはギャップ時計1本で足りる。
 *
 * 先生側にギャップ時計を掛けてはいけない。出力の文字起こしは音声と一緒に数秒で
 * まとめて届き、その後 turnComplete まで(モデルが再生終了を待つ間)何も来ない。
 * そこで閉じると字幕が割れるだけでなく、「先生のターンが終わった」がブラウザの
 * 再生中に発火して、進行の差し込みが生成に割り込む(実際にそうなっていた)。
 */

import type { Turn } from "../../shared/messages";

/** 学習者側: この時間だけ断片が来なければターンが閉じる。文中の息継ぎ(300〜700ms)より長くとる。 */
export const USER_TURN_GAP_MS = 1_200;

type Role = Turn["role"];

/** 役ごとのギャップ時計。無い役はタイマーで閉じず、close() の明示だけで閉じる。 */
export type TurnGaps = Partial<Record<Role, number>>;

export const DEFAULT_TURN_GAPS: TurnGaps = { user: USER_TURN_GAP_MS };

interface OpenTurn {
  id: string;
  text: string;
  timer: NodeJS.Timeout | null;
}

export interface TurnSink {
  onTurn(turn: Turn): void;
}

export class TurnProjector {
  private readonly open: Record<Role, OpenTurn | null> = { user: null, assistant: null };
  private seq = 0;

  get sequence(): number { return this.seq; }
  restoreSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || this.open.user || this.open.assistant) throw new Error("Invalid turn sequence");
    this.seq = sequence;
  }

  constructor(
    private readonly sink: TurnSink,
    private readonly gaps: TurnGaps = DEFAULT_TURN_GAPS,
  ) {}

  /**
   * 断片を追記する。finished は上流が「この文字起こしはここで終わり」と言ったときで、
   * その場で閉じる(空の断片に finished だけ付いていてもよい)。
   */
  fragment(role: Role, delta: string, finished = false): void {
    if (!delta && !finished) return;
    if (delta) {
      let cur = this.open[role];
      if (!cur) {
        this.seq += 1;
        cur = { id: `${role}_${this.seq}`, text: "", timer: null };
        this.open[role] = cur;
      }
      this.rearm(role, cur);
      // 断片はそのまま連結する。区切りは上流が入れてくる。
      cur.text += delta;
      this.sink.onTurn({ id: cur.id, role, text: cur.text, done: false });
    }
    if (finished) this.close(role);
  }

  /** その役のターンを閉じる(開いていなければ何もしない)。 */
  close(role: Role): void {
    const cur = this.open[role];
    if (!cur) return;
    if (cur.timer) clearTimeout(cur.timer);
    this.open[role] = null;
    this.sink.onTurn({ id: cur.id, role, text: cur.text, done: true });
  }

  /** その役のターンが開いている(= 話している途中)か。 */
  isOpen(role: Role): boolean {
    return this.open[role] !== null;
  }

  dispose(): void {
    for (const role of ["user", "assistant"] as Role[]) {
      const cur = this.open[role];
      if (cur?.timer) clearTimeout(cur.timer);
      this.open[role] = null;
    }
  }

  /** ギャップ時計を張り直す。その役に時計が無ければ何もしない。 */
  private rearm(role: Role, cur: OpenTurn): void {
    if (cur.timer) clearTimeout(cur.timer);
    const gap = this.gaps[role];
    cur.timer = gap === undefined ? null : setTimeout(() => this.close(role), gap);
  }
}
