import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const folder = new URL("../data/results/", import.meta.url);
const records = [];
let skipped = 0;
let files = [];
try { files = await readdir(folder); }
catch (error) { if (error.code !== "ENOENT") throw error; }
for (const name of files.filter(name => /^[a-z0-9_-]+\.jsonl$/.test(name)).sort()) {
  const sceneId = name.slice(0, -6);
  const lines = (await readFile(new URL(name, folder), "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { skipped++; continue; }
    if (!row || !["drill", "scene", "retell", "recast", "review"].includes(row.kind) || !Number.isFinite(Date.parse(row.at))) {
      skipped++; continue;
    }
    const hash = createHash("sha256").update(`${sceneId}:${index}:${JSON.stringify(row)}`).digest("hex");
    records.push({ sceneId, eventId: row.kind === "review" && typeof row.eventId === "string" ? row.eventId : `local:${hash}`, row });
  }
}
const output = new URL("../data/cloudflare-import.json", import.meta.url);
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify({ format: "englishteacher-results", version: 1, records }, null, 2), { mode: 0o600 });
console.log(`${records.length}件を ${fileURLToPath(output)} に書き出しました。読み取れなかった行: ${skipped}件`);
