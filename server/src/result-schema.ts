import type { AssessmentItem, DrillVerdict, RecastProps, ReviewOutcome, ReviewSeed, TargetStatusKind, TeachingNotes } from "../../shared/messages";

/** 瞬間英作文の1問。 */
export interface DrillResultRow {
  kind: "drill";
  at: string;
  scene: string;
  round: number;
  ja: string;
  en: string;
  verdict: DrillVerdict;
  said?: string;
  note?: string;
  latencyMs?: number;
  teaching?: TeachingNotes;
}

/** シーン会話の1表現(セッション終了時)。 */
export interface SceneResultRow {
  kind: "scene";
  at: string;
  scene: string;
  term: string;
  status: TargetStatusKind;
  said?: string;
  note?: string;
}

/** 話し直しの1回分。 */
export interface RetellTakeRow {
  transcript: string;
  seconds: number;
  words: number;
  /** 伝わった要点(日本語の短い札)。 */
  points: string[];
  /** その回で使ったヒントの数。 */
  hints: number;
  assessment?: AssessmentItem[];
}

/**
 * 話し直しトレーニング1セッション(終了時)。ファイルは data/results/retell.jsonl。
 * 「後日、別の画像でも説明できるか」を見るための材料で、要点の数・ヒントの数・
 * 改善点が2回目で使えたかを残す。画像そのものは残さない。
 */
export interface RetellResultRow {
  kind: "retell";
  at: string;
  /** 板に出した観点。 */
  prompts: string[];
  first?: RetellTakeRow;
  second?: RetellTakeRow;
  improvements: { original: string; better: string; note?: string; used?: boolean }[];
  question?: string;
  answer?: string;
  comment?: string;
  /** 締めまで行ったか(途中で終了を押したら false)。 */
  finished: boolean;
  teaching?: TeachingNotes;
}

export interface RecastResultRow extends Omit<RecastProps, "kind"> {
  kind: "recast";
  /** RecastProps.kind と区別して保存する。 */
  correctionKind?: "correction" | "upgrade";
  at: string;
  scene: string;
}

export interface ReviewResultRow {
  kind: "review";
  at: string;
  eventId: string;
  card: ReviewSeed;
  outcome: ReviewOutcome;
  attempts: number;
  said?: string;
}

export type ResultRow = DrillResultRow | SceneResultRow | RetellResultRow | RecastResultRow | ReviewResultRow;

/** 話し直しの結果ファイルの名前(シーンの id に当たる)。 */
export const RETELL_RESULTS_ID = "retell";

/** JSONL を行ごとに。壊れた行は飛ばす(手で編集して壊しても他が読める)。 */
export function parseJsonl(text: string): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed) as Partial<ResultRow> | null;
      if (v && ["drill", "scene", "retell", "recast", "review"].includes(v.kind ?? "")) rows.push(v as ResultRow);
    } catch {
      /* 壊れた行 */
    }
  }
  return rows;
}

/** 問題(模範解答の文)ごとの直近の判定。 */
export function lastDrillVerdicts(rows: readonly ResultRow[]): Map<string, DrillVerdict> {
  const out = new Map<string, DrillVerdict>();
  for (const row of rows) {
    if (row.kind === "drill") out.set(row.en, row.verdict);
  }
  return out;
}
