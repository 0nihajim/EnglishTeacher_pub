import { fileURLToPath } from "node:url";

// Node の起動時だけ読む。Workers では env bindings を使う。
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // 本番や、環境変数を直接指定している場合は .env 不要。
}
