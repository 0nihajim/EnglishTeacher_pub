/**
 * シーンの定義を読む。ユーザーが server/scenes/<id>.json に書く。
 *
 * 1シーン = 状況 + 表現・単語(targets)+ 瞬間英作文の問題(drills)。シーン会話と
 * 瞬間英作文が同じファイルを読むので、表現は一度書けば両方で使える。
 * drills を省けば targets から自動で作る(意味 → 表現)。
 *
 * ここは読み込みと検証だけで、中身の意味は modes/ が決める。壊れたファイルは
 * 起動時に名前と理由をログに出して飛ばす。1つの誤字でサーバーが上がらないより、
 * 他のシーンが使えるほうがよい。
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SceneSummary } from "../../shared/messages";

import { parseScene, summarize, SceneError, type Scene } from "./scene-schema";
export * from "./scene-schema";
export const SCENES_DIR = fileURLToPath(new URL("../scenes", import.meta.url));

export interface LoadedScenes {
  scenes: Scene[];
  /** 読めなかったファイルと理由。起動ログに出す。 */
  errors: string[];
}

/** ディレクトリの *.json を全部読む。壊れたものは errors に入れて飛ばす。 */
export function loadScenes(dir: string = SCENES_DIR): LoadedScenes {
  const scenes: Scene[] = [];
  const errors: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return { scenes, errors: [`${dir} を読めない`] };
  }
  const seen = new Set<string>();
  for (const file of files) {
    const fallbackId = basename(file, ".json");
    try {
      const scene = parseScene(JSON.parse(readFileSync(join(dir, file), "utf8")), fallbackId);
      if (seen.has(scene.id)) throw new SceneError(`id "${scene.id}" が別のファイルと重複`);
      seen.add(scene.id);
      scenes.push(scene);
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { scenes, errors };
}

// ── 登録簿(1プロセス) ─────────────────────────────────────────────────────────

let loaded: LoadedScenes | null = null;

/** 読み直す。起動時に呼び、結果をログに出す。 */
export function reloadScenes(dir: string = SCENES_DIR): LoadedScenes {
  loaded = loadScenes(dir);
  return loaded;
}

export function listScenes(): SceneSummary[] {
  return (loaded ?? reloadScenes()).scenes.map(summarize);
}

export function getScene(id: string): Scene | undefined {
  return (loaded ?? reloadScenes()).scenes.find((s) => s.id === id);
}
