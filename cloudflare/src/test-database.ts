import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/** 実際のSQLiteでスキーマ、制約、SQLトランザクションを検証するためのD1アダプター。 */
export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  // 本番と同じ順で全ての移行を当てる。新しい移行を足してもここは触らない。
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
  if (!files.length) throw new Error("移行ファイルが見つかりません");
  for (const name of files) {
    // D1 は移行ファイルを1つのバッチとして流すので、ここでも1ファイル1トランザクションにする。
    sqlite.exec("BEGIN");
    sqlite.exec(readFileSync(new URL(name, dir), "utf8"));
    sqlite.exec("COMMIT");
  }
  const prepare = (sql: string, values: unknown[] = []) => ({
    bind: (...params: unknown[]) => prepare(sql, params),
    first: async (column?: string) => {
      const row = sqlite.prepare(sql).get(...values as never[]) ?? null;
      return column && row ? row[column] : row;
    },
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values as never[]) }),
    run: async () => {
      const info = sqlite.prepare(sql).run(...values as never[]);
      return { success: true, results: [], meta: { changes: Number(info.changes) } };
    },
  });
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
