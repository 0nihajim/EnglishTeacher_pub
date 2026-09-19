// 公開設定を検査し、D1移行 → Worker配信 → Gemini secret登録を順に行う。
// secretは既存の.envから読み、コマンド引数や出力に含めない。
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
let raw;
try { raw = await readFile(join(root, "wrangler.jsonc"), "utf8"); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  throw new Error("wrangler.jsonc がありません。docs/cloudflare-setup.md の手順で作成してください。");
}
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
// 配布時のひな形は REPLACE_ME を入れてある。埋め忘れを名前を挙げて止める。
const unfilled = [];
const scan = (label, value) => { if (typeof value === "string" && value.includes("REPLACE_ME")) unfilled.push(label); };
scan("account_id", config.account_id);
for (const [key, value] of Object.entries(config.vars ?? {})) scan(`vars.${key}`, value);
for (const route of config.routes ?? []) scan("routes[].pattern", route.pattern);
for (const database of config.d1_databases ?? []) scan(`d1_databases(${database.binding}).database_id`, database.database_id);
for (const bucket of config.r2_buckets ?? []) scan(`r2_buckets(${bucket.binding}).bucket_name`, bucket.bucket_name);
if (unfilled.length) {
  throw new Error(`wrangler.jsonc の次の値が未設定です: ${unfilled.join(", ")}。docs/cloudflare-setup.md を参照。`);
}
if (!/^[0-9a-f]{32}$/i.test(config.account_id ?? "")) {
  throw new Error("wrangler.jsonc の account_id に Cloudflare の Account ID(32桁)を設定してください。");
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.vars.OWNER_EMAIL ?? "")) {
  throw new Error("wrangler.jsonc の OWNER_EMAIL に、このアプリを使う本人のメールを設定してください。");
}
const host = config.routes?.find(route => route.custom_domain)?.pattern ?? config.routes?.[0]?.pattern;
if (config.vars.APP_ORIGIN !== `https://${host}`) {
  throw new Error(`APP_ORIGIN と routes のホスト名が違います(APP_ORIGIN=${config.vars.APP_ORIGIN} / routes=${host})。`);
}
if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.vars.ACCESS_TEAM_DOMAIN)) {
  throw new Error("wrangler.jsonc の ACCESS_TEAM_DOMAIN にチームドメインを設定してください。");
}
if (!/^[a-f0-9]{64}$/i.test(config.vars.ACCESS_AUD)) throw new Error("Cloudflare AccessのAUDを確認してください。");
if (!/^[a-f0-9-]{36}$/i.test(config.d1_databases?.find(item => item.binding === "DB")?.database_id ?? "")) {
  throw new Error("D1を作成してDBバインディングのdatabase_idを設定してください。docs/cloudflare-setup.mdを参照。");
}
if (config.vars.LOCAL_DEV || config.workers_dev !== false || config.preview_urls !== false) {
  throw new Error("本番設定では開発用認証と別の公開URLを無効にしてください。");
}
let local = {};
try { local = parseEnv(await readFile(join(root, ".env"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
// --ci はGitHub Actionsのワークフロー専用。Gemini secretは登録済みのものを使い、ここでは触らない。
// 手元で誤って付けても本番に届かないよう、Actionsが注入する環境変数の存在を要求する。
const ciMode = process.argv.includes("--ci");
if (ciMode) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("--ci はGitHub Actionsの中だけで使います。手元からは npm run cf:deploy を実行してください。");
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error("CLOUDFLARE_API_TOKEN がありません。リポジトリの Settings → Secrets に登録してください。");
  }
}
const apiKey = process.env.GEMINI_API_KEY || local.GEMINI_API_KEY;
if (!apiKey && !ciMode) throw new Error("GEMINI_API_KEYをローカルの.envに設定してください。");
if (process.argv.includes("--check")) {
  console.log("公開設定とローカルのGeminiキーの検査に合格しました。");
  process.exit(0);
}
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: config.account_id,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG: "info",
  WRANGLER_LOG_PATH: join(tmpdir(), `${config.name}-deploy.log`),
};
function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root, env, input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    stdio: input === undefined ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    // Wranglerのsecret操作の失敗出力も、値を出さずに要約する。
    if (input !== undefined) console.error("Gemini secretの登録に失敗しました。認証を確認して再実行してください。");
    process.exit(result.status ?? 1);
  }
}
run("npm", ["run", "typecheck"]);
run("npm", ["run", "cf:check"]);
run("npm", ["test"]);
run("npm", ["run", "cf:test"]);
run("npm", ["run", "cf:smoke"]);
const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
const d1Name = config.d1_databases.find(database => database.binding === "DB").database_name;
run(process.execPath, [cli, "d1", "migrations", "apply", d1Name, "--remote"]);
run(process.execPath, [cli, "deploy"]);
if (ciMode) {
  console.log("Workerを配信しました。Gemini secretは登録済みのものをそのまま使います(--ciでは登録しません)。");
} else {
  run(process.execPath, [cli, "secret", "bulk"], JSON.stringify({ GEMINI_API_KEY: apiKey }));
  console.log("WorkerとGemini secretを登録しました。ブラウザでログインし、音声と履歴の実機確認を行ってください。");
}
