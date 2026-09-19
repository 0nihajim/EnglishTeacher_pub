/**
 * ボード(whiteboard)のコーチ。
 *
 * 学習者はキャンバスに描きながら話し、先生は板のフレームを見て話す。Phase 1 は自由会話で、
 * 進行はほとんど無い: 板のフレームは session.ts が上流に流し、ここには「送った」の連絡だけが
 * 来る。表示のツール(show_recast、show_term_card、hide_card)を受けて画面に出すだけで、
 * 結果は記録しない。言い直しはそのセッションの指導ノート(ブラウザ側)に残るが、
 * 「今日の復習」の課題にはならない。
 *
 * 先生に板の変化を nudge で知らせることはしない。フレームは realtimeInput で文脈に入るので、
 * 学習者が次に話したときに先生はそれを見て答える。clientContent で知らせると生成中の発話を切る。
 */

import type { ToolReply } from "../gemini";
import { dispatchToolCall } from "../tools";
import type { Coach, CoachHost } from "./types";
import { capture, restore, type CoachCheckpoint } from "./checkpoint";

const CHECKPOINT_KEYS = ["frames", "teacherTurns", "recasts"] as const;

export class WhiteboardCoach implements Coach {
  checkpoint(): CoachCheckpoint { return capture(this, "whiteboard", CHECKPOINT_KEYS); }
  restore(checkpoint: CoachCheckpoint): boolean { return restore(this, checkpoint, "whiteboard", CHECKPOINT_KEYS); }

  /** 先生に送った板のフレームの数。 */
  private frames = 0;
  private teacherTurns = 0;
  /** 言い直しの数。 */
  private recasts = 0;
  private disposed = false;

  constructor(private readonly host: CoachHost) {}

  /** 送ったフレームの数(読み取り専用)。 */
  get frameCount(): number {
    return this.frames;
  }

  boardChanged(seq: number): void {
    if (this.disposed) return;
    this.frames += 1;
    if (this.frames === 1) this.host.log(`板に最初の変化(#${seq})`);
  }

  learnerSaid(_text: string, _done: boolean): void {}

  teacherSaid(_text: string): void {}

  teacherTurnDone(): void {
    if (this.disposed) return;
    this.teacherTurns += 1;
  }

  onToolCall(name: string, args: Record<string, unknown>): ToolReply {
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
      if (outcome.ui.widget === "recast") this.recasts += 1;
    }
    return outcome.reply;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.log(`ボード終了: フレーム ${this.frames} 枚、先生のターン ${this.teacherTurns}、言い直し ${this.recasts}`);
  }
}
