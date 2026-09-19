#!/usr/bin/env node
/**
 * 開発サーバー2本(サーバーとブラウザ側)を同時に上げる。
 *
 * npm workspaces には pnpm の `--parallel -r` に当たるものが無い。並列実行の
 * ためだけに依存を1つ増やすより、spawn を書くほうが短い。
 * どちらかが落ちたらもう一方も畳む。片方だけ生きていても使えない。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const targets = [
  { name: "server", color: "\u001b[36m" },
  { name: "web", color: "\u001b[35m" },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  process.exitCode = code ?? 0;
}

for (const target of targets) {
  const child = spawn("npm", ["run", "dev", "-w", target.name], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  children.push(child);

  const prefix = `${target.color}[${target.name}]\u001b[0m `;
  const pipe = (stream, out) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
    stream.on("end", () => {
      if (rest) out.write(prefix + rest + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`${prefix}終了 (code ${code}) — もう一方も止めます`);
      shutdown(code ?? 1);
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

console.log("\n  ブラウザ: http://127.0.0.1:5173\n");
