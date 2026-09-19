/**
 * ツールの振り分け — 呼び出し1件を、ブラウザが描く `ui` メッセージに変える。
 *
 * 値はモデルから来るので信用しない。長さはここで切り、ブラウザ側は textContent
 * だけで描く。モデルに呼ばせるためのプロンプトは prompts.ts にある。
 *
 * ここに来るのは「画面に出すだけ」のツール。進行に関わるもの(report_target、
 * show_progress、drill_result)はコーチ(modes/)が自分で受ける。
 */

import type { RecastProps, TermCardProps, UiMessage } from "../../shared/messages";
import { findTool } from "../../shared/tools";
import type { ToolReply } from "./gemini";
import { teachingFromTool } from "./feedback";

export interface ToolOutcome {
  /** 画面に出すもの。無ければ画面は触らない(「消す」とは別)。 */
  ui?: UiMessage;
  reply: ToolReply;
}

/** モデル由来の文字列を1本に整える。文字列でない・空なら undefined。 */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function dispatchToolCall(name: string, args: Record<string, unknown>): ToolOutcome | null {
  const def = findTool(name);
  if (!def) return null;
  const scheduling = def.scheduling;

  switch (name) {
    case "show_term_card": {
      const term = text(args.term, 120);
      if (!term) return null;
      const props: TermCardProps = { term };
      const reading = text(args.reading, 160);
      const meaning = text(args.meaning, 160);
      const example = text(args.example, 200);
      if (reading) props.reading = reading;
      if (meaning) props.meaning = meaning;
      if (example) props.example = example;
      return {
        ui: { widget: "term_card", props },
        reply: { response: { shown: true }, scheduling },
      };
    }
    case "hide_card":
      return {
        ui: { widget: "hide", props: {} },
        reply: { response: { shown: true }, scheduling },
      };
    case "show_recast": {
      // 学習者の文と言い直し。どちらも欠けたらカードにならない。
      const original = text(args.original, 200);
      const better = text(args.better, 200);
      if (!original || !better) return null;
      const props: RecastProps = { original, better };
      const note = text(args.note, 160);
      if (note) props.note = note;
      if (args.kind === "correction" || args.kind === "upgrade") props.kind = args.kind;
      const teaching = teachingFromTool(args);
      if (teaching) props.teaching = teaching;
      return {
        ui: { widget: "recast", props },
        reply: { response: { shown: true }, scheduling },
      };
    }
    default:
      // report_target・show_progress・drill_result は進行に関わるので、
      // コーチ(modes/)が受ける。ここに落ちたら扱わないという返事になる。
      return null;
  }
}
