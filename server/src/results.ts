/**
 * 結果の記録。data/results/<sceneId>.jsonl に1行1件で追記する。
 *
 * DB は入れない。1プロセス・手元で動かす前提では、追記だけのファイルが
 * いちばん壊れにくく、読むのも grep で足りる。読む側が使うのは
 * 瞬間英作文の出題順と、個人復習の課題・次回日時を履歴から再構築するために使う。
 */

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, type ResultRow } from "./result-schema";
export * from "./result-schema";

export const RESULTS_DIR = fileURLToPath(new URL("../../data/results", import.meta.url));

const fileFor = (dir: string, sceneId: string) => join(dir, `${sceneId}.jsonl`);
const writes = new Map<string, Promise<void>>();

export async function appendResults(
  sceneId: string,
  rows: readonly ResultRow[],
  dir: string = RESULTS_DIR,
): Promise<void> {
  if (rows.length === 0) return;
  const file = fileFor(dir, sceneId);
  const write = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dir, { recursive: true });
    await appendFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  });
  writes.set(file, write);
  try {
    await write;
  } finally {
    if (writes.get(file) === write) writes.delete(file);
  }
}

export async function readResults(sceneId: string, dir: string = RESULTS_DIR): Promise<ResultRow[]> {
  await writes.get(fileFor(dir, sceneId));
  let text: string;
  try {
    text = await readFile(fileFor(dir, sceneId), "utf8");
  } catch {
    return [];
  }
  return parseJsonl(text);
}

/** 復習計画は全モードの履歴から再構築する。別の状態ファイルとの同期は不要。 */
export async function readAllResults(dir: string = RESULTS_DIR): Promise<ResultRow[]> {
  await Promise.all([...writes.entries()].filter(([file]) => file.startsWith(`${dir}/`)).map(([, write]) => write));
  let files;
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const contents = await Promise.all(files.filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => readFile(join(dir, f.name), "utf8")));
  return contents.flatMap(parseJsonl);
}
