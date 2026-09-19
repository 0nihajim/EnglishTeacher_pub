// D1 の移行を適用する。DB の名前は wrangler.jsonc から読むので、名前を変えてもここは直さない。
// 使い方: node scripts/cloudflare-migrate.mjs --local | --remote
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (!target) throw new Error("--local か --remote のどちらかを指定してください。");
let raw;
try { raw = await readFile(join(root, "wrangler.jsonc"), "utf8"); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  throw new Error("wrangler.jsonc がありません。docs/cloudflare-setup.md の手順で作成してください。");
}
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
const database = config.d1_databases?.find(item => item.binding === "DB");
if (!database?.database_name) throw new Error("wrangler.jsonc に DB バインディングの database_name がありません。");
if (target === "--remote" && String(database.database_id).includes("REPLACE_ME")) {
  throw new Error("database_id が未設定です。wrangler d1 create でD1を作り、IDを wrangler.jsonc に設定してください。");
}
const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
const result = spawnSync(process.execPath, [cli, "d1", "migrations", "apply", database.database_name, target], {
  cwd: root, stdio: "inherit",
});
process.exit(result.status ?? 1);
