#!/usr/bin/env node
/**
 * 起動前の門。.env が無い、あるいは鍵が空のまま `npm run dev` すると、
 * ブラウザで「はじめる」を押して初めて 500 で気づくことになる。ここで止める。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

if (!existsSync(envPath)) {
  console.error("\n✗ .env がありません。");
  console.error("  cp .env.example .env  してから GEMINI_API_KEY を埋めてください。");
  console.error("  鍵の取得: https://aistudio.google.com/apikey\n");
  process.exit(1);
}

const text = readFileSync(envPath, "utf8");
const value = /^GEMINI_API_KEY=(.*)$/m.exec(text)?.[1]?.trim() ?? "";

if (!value) {
  console.error("\n✗ .env の GEMINI_API_KEY が空です。");
  console.error("  鍵の取得: https://aistudio.google.com/apikey\n");
  process.exit(1);
}

console.log("✓ .env を確認しました");
