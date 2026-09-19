/**
 * モードからセッションの計画(SessionPlan)を組む。system instruction、挨拶、
 * 宣言するツール、コーチの4点。index.ts が /api/session/start で呼ぶ。
 *
 * シーン会話と瞬間英作文はシーン(server/scenes/*.json)が要る。表現も問題もそこにあり、
 * 中身を持たないモードは無い。話し直しはシーンの代わりに学習者の画像が要る。
 *
 * ツールはモードごとに絞る。瞬間英作文にカードのツールを見せると、判定の
 * 代わりにカードを出し始める。話し直しに show_recast を見せると、アプリが出す
 * 改善点のカードと二重になる。
 */

import type { Mode, ReviewSeed } from "../../../shared/messages";
import { TOOLS, type ToolDef } from "../../../shared/tools";
import { config } from "../config";
import { GeminiAnalyst, type Analyst } from "../flash";
import type { LearnerImage } from "../image";
import {
  DRILL_ADDENDUM,
  LANGUAGE_DIRECTIVE,
  PERSONA,
  RETELL_ADDENDUM,
  RETELL_TOOL_DIRECTIVE,
  REVIEW_ADDENDUM,
  SCENE_ADDENDUM,
  SCENE_TOOL_DIRECTIVE,
  TOOL_DIRECTIVE,
  WHITEBOARD_ADDENDUM,
  WHITEBOARD_TOOL_DIRECTIVE,
  drillDirective,
  drillGreeting,
  retellDirective,
  retellGreeting,
  sceneDirective,
  sceneGreeting,
  whiteboardGreeting,
} from "../prompts";
import { RETELL_RESULTS_ID, lastDrillVerdicts, type ResultRow } from "../result-schema";
import type { Scene } from "../scenes";
import { DrillRunner } from "./drill";
import { RetellCoach } from "./retell";
import { SceneCoach } from "./scene";
import { ReviewCoach, reviewGreeting } from "./review";
import { WhiteboardCoach } from "./whiteboard";
import type { SessionPlan } from "./types";
import type { ResultStore } from "../result-store";

function pick(...names: string[]): ToolDef[] {
  return names.map((name) => {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) throw new Error(`shared/tools.ts に ${name} が無い`);
    return def;
  });
}

export const SCENE_TOOLS: readonly ToolDef[] = pick(
  "show_term_card",
  "show_recast",
  "report_target",
  "show_progress",
  "hide_card",
);
export const DRILL_TOOLS: readonly ToolDef[] = pick("drill_result");
export const RETELL_TOOLS: readonly ToolDef[] = pick("show_term_card", "hide_card");
export const REVIEW_TOOLS: readonly ToolDef[] = pick("review_result");
export const WHITEBOARD_TOOLS: readonly ToolDef[] = pick("show_recast", "show_term_card", "hide_card");

/** 何で始めるか。scene / drill はシーン、retell は画像、whiteboard は何も要らない。 */
export type PlanRequest =
  | { mode: Extract<Mode, "scene" | "drill">; scene: Scene }
  | { mode: "retell"; image: LearnerImage }
  | { mode: "review"; cards: readonly ReviewSeed[] }
  | { mode: "whiteboard" };

/** 記録の書き込み失敗はセッションを止めない。ログに出すだけ。 */
export async function buildPlan(
  request: PlanRequest,
  store: ResultStore,
  analyst?: Analyst,
): Promise<SessionPlan> {
  const persist = (id: string, rows: readonly ResultRow[]): void => {
    void store.append(id, rows).catch((err: unknown) => {
      console.warn(`[results] 書けなかった (${id}): ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  switch (request.mode) {
    case "whiteboard": {
      return {
        mode: "whiteboard",
        label: "ボード",
        systemInstruction:
          PERSONA + LANGUAGE_DIRECTIVE + WHITEBOARD_ADDENDUM + TOOL_DIRECTIVE + WHITEBOARD_TOOL_DIRECTIVE,
        greeting: whiteboardGreeting(),
        tools: WHITEBOARD_TOOLS,
        // 結果は記録しない。ボードの言い直しは「今日の復習」の課題にしない。
        coach: (host) => new WhiteboardCoach(host),
      };
    }
    case "review": {
      if (!request.cards.length) throw new Error("復習する課題がありません");
      return {
        mode: "review", label: `今日の復習: ${request.cards.length}課題`,
        systemInstruction: PERSONA + LANGUAGE_DIRECTIVE + REVIEW_ADDENDUM,
        greeting: reviewGreeting(request.cards.length),
        tools: REVIEW_TOOLS,
        coach: (host) => new ReviewCoach(host, request.cards, {
          onOutcome: (row) => persist("_reviews", [row]),
        }),
      };
    }
    case "scene": {
      const { scene } = request;
      return {
        mode: "scene",
        label: `シーン会話: ${scene.title}`,
        systemInstruction:
          PERSONA + LANGUAGE_DIRECTIVE + SCENE_ADDENDUM + TOOL_DIRECTIVE + SCENE_TOOL_DIRECTIVE + sceneDirective(scene),
        greeting: sceneGreeting(scene),
        tools: SCENE_TOOLS,
        coach: (host) => new SceneCoach(host, scene, {
          onOutcome: (rows) => persist(scene.id, rows),
          onFeedback: ({ kind, ...feedback }) => persist(scene.id, [{
            ...feedback, kind: "recast", correctionKind: kind, scene: scene.id, at: new Date().toISOString(),
          }]),
        }),
      };
    }
    case "drill": {
      const { scene } = request;
      // 前回までの結果。間違えた問題を先に出す。
      const lastVerdicts = lastDrillVerdicts(await store.read(scene.id));
      return {
        mode: "drill",
        label: `瞬間英作文: ${scene.title}`,
        systemInstruction: PERSONA + LANGUAGE_DIRECTIVE + DRILL_ADDENDUM + drillDirective(scene),
        greeting: drillGreeting(scene),
        tools: DRILL_TOOLS,
        coach: (host) => new DrillRunner(host, scene, { lastVerdicts, onOutcome: (row) => persist(scene.id, [row]) }),
      };
    }
    case "retell": {
      const { image } = request;
      return {
        mode: "retell",
        label: `話し直し: ${image.mimeType.replace("image/", "")} ${Math.round(image.bytes / 1024)}KB`,
        systemInstruction:
          PERSONA + LANGUAGE_DIRECTIVE + RETELL_ADDENDUM + TOOL_DIRECTIVE + RETELL_TOOL_DIRECTIVE + retellDirective(),
        greeting: retellGreeting(),
        tools: RETELL_TOOLS,
        image,
        captureSpeech: true,
        coach: (host) =>
          new RetellCoach(host, image, {
            analyst: analyst ?? new GeminiAnalyst(config.gemini.flashModel, undefined, host.log),
            onOutcome: (row) => persist(RETELL_RESULTS_ID, [row]),
          }),
      };
    }
  }
}
