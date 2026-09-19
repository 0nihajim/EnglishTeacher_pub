// デプロイ用の同じバンドルをworkerdで起動する。待ち受けポート・外部通信は不要。
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse((await readFile(join(root, "wrangler.jsonc"), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
const folder = await mkdtemp(join(tmpdir(), "englishteacher-smoke-"));
try {
  await copyFile(join(root, ".wrangler/build/index.js"), join(folder, "worker.mjs"));
  await writeFile(join(folder, "main.mjs"), `
import worker from "./worker.mjs";
function equal(actual, expected) { if (actual !== expected) throw new Error("Expected " + expected + ", got " + actual); }
export default { async test() {
  const env = { APP_ORIGIN: "https://english.example.com", OWNER_EMAIL: "owner@example.com",
    ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
  equal((await worker.fetch(new Request(env.APP_ORIGIN + "/"), env)).status, 503);
  const configured = { ...env, ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "our-app" };
  for (const path of ["/", "/assets/index.js", "/api/scenes", "/api/history", "/ws/unknown"]) {
    equal((await worker.fetch(new Request(env.APP_ORIGIN + path), configured)).status, 401);
  }
  equal((await worker.fetch(new Request("https://alternate.workers.dev/"), configured)).status, 403);
  const local = { ...env, LOCAL_DEV: "true", DB: {
    prepare() { return { bind() { return this; }, async run() { return { success: true }; } }; }
  }};
  const scenes = await worker.fetch(new Request("http://localhost/api/scenes"), local);
  equal(scenes.status, 200);
  if (!(await scenes.json()).scenes.length) throw new Error("Bundled scenes were not loaded.");
  equal((await worker.fetch(new Request("http://localhost/api/session/start", { method: "POST" }), local)).status, 403);
  console.log("PASS: Worker startup, protected assets/API, origin validation, bundled scenes.");
} };`);
  await writeFile(join(folder, "test.capnp"), `
using Workerd = import ${JSON.stringify(require.resolve("workerd/workerd.capnp"))};
const config :Workerd.Config = (services = [(name = "test", worker = (
  compatibilityDate = ${JSON.stringify(config.compatibility_date)},
  compatibilityFlags = ${JSON.stringify(config.compatibility_flags)},
  modules = [
    (name = "main.mjs", esModule = embed "main.mjs"),
    (name = "worker.mjs", esModule = embed "worker.mjs")
  ]
))]);`);
  const result = spawnSync(require("workerd").default, ["test", join(folder, "test.capnp"), "--experimental", "--import-path=/"], {
    cwd: root, stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(folder, { recursive: true, force: true });
}
