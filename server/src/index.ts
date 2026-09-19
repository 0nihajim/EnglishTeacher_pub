/**
 * HTTP と WebSocket の入口。
 *
 *   GET  /api/scenes         → シーンの一覧(server/scenes/*.json)
 *   GET  /api/review/today   → 履歴から選んだ復習の計画(答えは含めない)
 *   POST /api/session/start  → セッションを作る(上流にはまだ繋がない)。body でモードと
 *                              シーン(シーン会話・瞬間英作文)か画像(話し直し)。ボードは何も要らない
 *   POST /api/session/stop   → 畳む
 *   GET  /healthz
 *   WS   /ws/:sessionId      → ブラウザの脚。マイク音声と板のフレーム(ボード)が上り、
 *                              先生の音声・字幕・カードが下る
 *
 * 開発時は Vite(:5173)が /api と /ws をここへ中継するので、ブラウザから見て
 * オリジンは1つ。本番はこのサーバーが web/dist も配る。
 *
 * ⚠ 認証は意図的に無い。手元で動かす出発点なので、ブラウザから叩けるものは
 * 誰でも叩ける。外に出すなら最低限この2か所を塞ぐこと:
 *   1. POST /api/session/start に何らかのログインを要求する。塞がないと、URL を
 *      知っている誰でも Gemini のセッションを開けて、課金はこの API キーに乗る。
 *   2. WS の upgrade を /start が発行する短命チケットで検証する。セッション ID は
 *      推測できないが、漏れたら他人のレッスンの音声に相乗りできる。
 * API キー自体はサーバーに留まりブラウザには渡らないので、そこは既に安全側。
 */

import "./load-env";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage, Mode, StartRequest, StartResponse, TurnTaking } from "../../shared/messages";
import { config, missingConfig } from "./config";
import { ImageError, parseLearnerImage } from "./image";
import { buildPlan, type PlanRequest } from "./modes/index";
import { addSession, getSession, liveCount, stopAll, stopSession } from "./registry";
import { getScene, listScenes, reloadScenes, type Scene } from "./scenes";
import { Session } from "./session";
import { readAllResults, readResults, appendResults } from "./results";
import { dailyReview } from "./review";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    console.error("[http] 未処理の例外:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "GET" && path === "/api/scenes") {
    json(res, 200, { scenes: listScenes() });
    return;
  }
  if (req.method === "GET" && path === "/api/review/today") {
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, (await loadDailyReview()).plan);
    return;
  }
  if (req.method === "POST" && path === "/api/session/start") return handleStart(req, res);
  if (req.method === "POST" && path === "/api/session/stop") return handleStop(req, res);
  return serveStatic(res, path);
}

async function loadDailyReview() {
  return dailyReview(await readAllResults(), listScenes().flatMap((s) => {
    const scene = getScene(s.id);
    return scene ? [scene] : [];
  }));
}

async function handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const missing = missingConfig();
  if (missing.length > 0) {
    json(res, 500, {
      error: `環境変数が足りません: ${missing.join(", ")} — .env.example を .env にコピーして埋めてください`,
    });
    return;
  }
  // 話し直しは画像が載るので、body の上限だけ大きい。
  const body = (await readJson(req, MAX_START_BODY_BYTES)) as StartRequest;
  // 知らない値はシーン会話に落とす。
  const mode: Mode =
    body.mode === "drill" || body.mode === "retell" || body.mode === "review" || body.mode === "whiteboard"
      ? body.mode
      : "scene";
  let request: PlanRequest;
  let sceneTitle: string | undefined;
  if (mode === "whiteboard") {
    // 板は接続後に board_frame で届く。ここで要るものは無い。
    request = { mode };
  } else if (mode === "review") {
    const { cards } = await loadDailyReview();
    if (!cards.length) {
      json(res, 409, { error: "いま復習する課題はありません。ホームを更新してください。" });
      return;
    }
    request = { mode, cards };
  } else if (mode === "retell") {
    try {
      request = { mode, image: parseLearnerImage(body.image) };
    } catch (err) {
      json(res, 400, { error: err instanceof ImageError ? err.message : "画像を読めませんでした" });
      return;
    }
  } else {
    const scene: Scene | undefined = typeof body.scene_id === "string" ? getScene(body.scene_id) : undefined;
    if (!scene) {
      json(res, 400, { error: "シーンを選んでください(server/scenes/ に JSON を置くと一覧に出ます)" });
      return;
    }
    request = { mode, scene };
    sceneTitle = scene.title;
  }
  // 発話の区切り。知らない値は自動(最初からある動き)に落とす。話し直しは手動に固定 —
  // 先生が最後まで待つこと、詰まったときだけヒントが出ることが、この練習の前提。
  const turnTaking: TurnTaking = mode === "retell" || mode === "review" || body.turn_taking === "manual" ? "manual" : "auto";
  const plan = await buildPlan(request, { read: readResults, append: appendResults });
  const sessionId = randomUUID();
  const session = new Session(sessionId, plan, turnTaking, (id) => {
    void stopSession(id, "leg_died");
  });
  addSession(session);
  console.log(
    `[http] セッション作成: ${sessionId} (${plan.label}, 区切り: ${turnTaking === "manual" ? "手動" : "自動"}, ${liveCount()} live)`,
  );
  const response: StartResponse = {
    session_id: sessionId,
    // 相対にしておく。ブラウザは読み込んだのと同じオリジンに繋ぐ
    // (開発時は Vite の中継、本番はこのサーバー)。
    ws_path: `/ws/${sessionId}`,
    mode,
    turn_taking: turnTaking,
  };
  if (sceneTitle) response.scene_title = sceneTitle;
  json(res, 201, response);
}

async function handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as { session_id?: string };
  if (typeof body.session_id === "string") await stopSession(body.session_id, "client_stop");
  // すでに無いのも成功。消えていてほしくて消えている。
  res.writeHead(204).end();
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = normalize(join(WEB_DIST, rel));
  if (!filePath.startsWith(normalize(WEB_DIST))) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) throw new Error("dir");
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(await readFile(filePath));
    return;
  } catch {
    /* 下の index.html へ落ちる */
  }
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(join(WEB_DIST, "index.html")));
  } catch {
    res.writeHead(404).end("not found — 開発中は Vite 側 (npm run dev) を開いてください");
  }
}

// ── ブラウザの WebSocket ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const match = /^\/ws\/([A-Za-z0-9-]+)$/.exec(new URL(req.url ?? "", "http://x").pathname);
  const session = match?.[1] ? getSession(match[1]) : undefined;
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // 1セッションに1ブラウザ。競争に負けた側(2つめのタブ、二度押し)は
    // 下の後片付けに入らずに閉じるので、勝った側のセッションを止められない。
    if (!session.tryAttachFrontend(ws)) {
      ws.close(1008, "already connected");
      return;
    }
    console.log(`[ws] ブラウザが接続: ${session.sessionId}`);
    // ブラウザが付いてから上流に繋ぐ。挨拶が誰もいない部屋で流れるのを防ぐ。
    session.start();

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "mic_audio" && typeof msg.audio === "string" && msg.audio) {
        session.sendMicAudio(msg.audio);
      } else if (msg.type === "mic_end") {
        session.endMicStream();
      } else if (msg.type === "speech_start") {
        session.startSpeech();
      } else if (msg.type === "speech_end") {
        session.endSpeech();
      } else if (msg.type === "control" && ["skip", "hint", "reveal", "retry", "next"].includes(msg.action)) {
        session.control(msg.action);
      } else if (msg.type === "board_frame") {
        // 中身の検査と間引きはセッションが持つ。ここは形だけ見る。
        session.boardFrame(msg, typeof msg.seq === "number" ? msg.seq : 0);
      }
    });

    ws.on("close", () => {
      session.detachFrontend(ws);
      // ブラウザが去ればセッションは終わり。再接続の経路は無く、
      // 誰も見ていないセッションに課金を続ける理由も無い。
      void stopSession(session.sessionId, "frontend_disconnect");
    });
  });
});

// ── 起動 ──────────────────────────────────────────────────────────────────────

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[server] http://127.0.0.1:${config.port} で待機`);
  // シーンは起動時に一度読む。壊れたファイルはここで名前と理由が出る。
  const { scenes, errors } = reloadScenes();
  console.log(`[server] シーン ${scenes.length} 件: ${scenes.map((s) => s.id).join(", ") || "(なし)"}`);
  for (const error of errors) console.warn(`[server] ⚠ シーンを読めません: ${error}`);
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(`[server] ⚠ 環境変数が足りません: ${missing.join(", ")} — セッションは開始できません`);
    console.warn("[server]   .env.example を .env にコピーして埋めてください");
  }
});

// セッションはこのプロセスの中にしかない。終了はその終わりでもある。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stopAll().finally(() => process.exit(0));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** /api の body はふつうセッション ID 1つしか載らない。それより大きいものは読まない。 */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * /api/session/start だけは画像(base64)が載る。ブラウザが長辺 1280px に縮めるので
 * 実際は 1〜2MB。上限は image.ts の 6MB を base64 にした分より少し上。
 */
const MAX_START_BODY_BYTES = 10 * 1024 * 1024;

function readJson(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      data += chunk.toString();
      if (data.length > maxBytes) {
        overflow = true;
        data = "";
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
