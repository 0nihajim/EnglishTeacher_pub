import type { SceneSummary } from "../../shared/messages";

export interface SceneTarget {
  /** 表現そのもの。英語。 */
  term: string;
  /** 日本語の意味。 */
  meaning: string;
  /** 読み(カタカナ)。カードに出す。 */
  reading?: string;
  /** 使う場面が分かる例文。 */
  example?: string;
  /** 同じ表現と見なす別形。文字起こしの照合に使う: "I am working on"。 */
  variants: string[];
}

export interface DrillItem {
  /** 出題する日本語文。 */
  ja: string;
  /** 模範解答。 */
  en: string;
  /** 正解扱いする別解。 */
  accept: string[];
}

export interface Scene {
  id: string;
  title: string;
  /** 先生に渡す状況説明。英語で書くと先生がそのまま使える。 */
  situation: string;
  /** 学習者の役。 */
  learnerRole?: string;
  /** 瞬間英作文で日本語文を先生が読み上げるか。false なら画面だけ。 */
  promptVoice: boolean;
  /** 瞬間英作文の1問の制限時間。過ぎたら先生がヒントを出す。 */
  drillLimitMs: number;
  targets: SceneTarget[];
  drills: DrillItem[];
}

export const DEFAULT_DRILL_LIMIT_MS = 8_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class SceneError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function text(obj: Record<string, unknown>, key: string, where: string, max: number): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new SceneError(`${where}: "${key}" は空でない文字列が必要`);
  }
  return v.trim().slice(0, max);
}

function optText(obj: Record<string, unknown>, key: string, where: string, max: number): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new SceneError(`${where}: "${key}" は文字列`);
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function strList(obj: Record<string, unknown>, key: string, where: string, max: number): string[] {
  const v = obj[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new SceneError(`${where}: "${key}" は文字列の配列`);
  }
  return (v as string[]).map((x) => x.trim().slice(0, max)).filter((x) => x !== "");
}

/** JSON をシーンに。壊れていれば SceneError(どこが、なぜ)。 */
export function parseScene(raw: unknown, fallbackId: string): Scene {
  if (!isRecord(raw)) throw new SceneError(`${fallbackId}: JSON のトップはオブジェクト`);
  const id = optText(raw, "id", fallbackId, 60) ?? fallbackId;
  if (!ID_PATTERN.test(id)) {
    throw new SceneError(`${fallbackId}: id "${id}" は英小文字・数字・-_ だけ(先頭は英数字)`);
  }
  const where = `scene "${id}"`;

  const title = text(raw, "title", where, 80);
  const situation = text(raw, "situation", where, 2_000);
  const learnerRole = optText(raw, "learnerRole", where, 200);

  const promptVoice = raw.promptVoice === undefined ? true : raw.promptVoice;
  if (typeof promptVoice !== "boolean") throw new SceneError(`${where}: "promptVoice" は true/false`);

  const limit = raw.drillLimitMs === undefined ? DEFAULT_DRILL_LIMIT_MS : raw.drillLimitMs;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1_000) {
    throw new SceneError(`${where}: "drillLimitMs" は 1000 以上の数(ミリ秒)`);
  }

  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new SceneError(`${where}: "targets" は1つ以上`);
  }
  const targets: SceneTarget[] = raw.targets.map((t, i) => {
    const at = `${where} targets[${i}]`;
    if (!isRecord(t)) throw new SceneError(`${at}: オブジェクトが必要`);
    const target: SceneTarget = {
      term: text(t, "term", at, 120),
      meaning: text(t, "meaning", at, 160),
      variants: strList(t, "variants", at, 120),
    };
    const reading = optText(t, "reading", at, 160);
    if (reading) target.reading = reading;
    const example = optText(t, "example", at, 200);
    if (example) target.example = example;
    return target;
  });

  let drills: DrillItem[];
  if (raw.drills === undefined || (Array.isArray(raw.drills) && raw.drills.length === 0)) {
    // 問題を書かなければ、表現の「意味 → 表現」を問題にする。
    drills = targets.map((t) => ({ ja: t.meaning, en: t.term, accept: [...t.variants] }));
  } else {
    if (!Array.isArray(raw.drills)) throw new SceneError(`${where}: "drills" は配列`);
    drills = raw.drills.map((d, i) => {
      const at = `${where} drills[${i}]`;
      if (!isRecord(d)) throw new SceneError(`${at}: オブジェクトが必要`);
      return { ja: text(d, "ja", at, 200), en: text(d, "en", at, 200), accept: strList(d, "accept", at, 200) };
    });
  }

  const scene: Scene = { id, title, situation, promptVoice, drillLimitMs: limit, targets, drills };
  if (learnerRole) scene.learnerRole = learnerRole;
  return scene;
}

export function summarize(scene: Scene): SceneSummary {
  return { id: scene.id, title: scene.title, targets: scene.targets.length, drills: scene.drills.length };
}

