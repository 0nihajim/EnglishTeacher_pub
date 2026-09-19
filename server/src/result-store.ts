import type { ResultRow } from "./results";

/** 保存先とユーザー・セッションのスコープを呼び出し元が決める。 */
export interface ResultStore {
  read(sceneId: string): Promise<ResultRow[]>;
  append(sceneId: string, rows: readonly ResultRow[]): Promise<void>;
}
