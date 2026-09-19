import type { StartRequest } from "../../shared/messages";
import { authenticate, requireSameOrigin, type Identity } from "./auth";
import { ensureUser, ownedSession, dailyReview, scenes } from "./store";
import { summarize } from "../../server/src/scene-schema";
import { errorResponse, HttpError, json, limitedBody, readJson } from "./http";
import { compressedAudioType, MAX_RECORDING_BYTES } from "./recording-policy";
import { progressRequest, type RecordingRow } from "./user-progress";

export { LessonSession } from "./lesson-session";
export { UserProgress } from "./user-progress";

async function route(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method) || url.pathname.startsWith("/ws/")) requireSameOrigin(request, env);
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/ws/")) {
    if (url.pathname === "/healthz") return json({ ok: true });
    const response = await env.ASSETS.fetch(request);
    const secured = new Response(response.body, response);
    secured.headers.set("Cache-Control", "private, no-store");
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Referrer-Policy", "same-origin");
    return secured;
  }
  await ensureUser(env.DB, user);
  if (url.pathname === "/api/import/results" && request.method === "POST") {
    const body = await readJson(request, 220_000);
    if (typeof body.eventId !== "string" || !body.eventId || body.eventId.length > 160 ||
        typeof body.sceneId !== "string" || !/^[a-z0-9_-]{1,60}$/.test(body.sceneId) ||
        !body.row || typeof body.row !== "object" || Array.isArray(body.row) ||
        !["drill", "scene", "retell", "recast", "review"].includes((body.row as { kind: string }).kind)) {
      throw new HttpError(400, "取り込みデータの形式が正しくありません");
    }
    await progressRequest(env, user.id, "/result", { ...body, sessionId: null });
    return json({ imported: true });
  }
  if (url.pathname === "/api/scenes" && request.method === "GET") return json({ scenes: scenes.map(summarize) });
  if (url.pathname === "/api/review/today" && request.method === "GET") return json((await dailyReview(env.DB, user.id)).plan);
  if (url.pathname === "/api/session/start" && request.method === "POST") {
    if (!env.GEMINI_API_KEY) throw new HttpError(503, "音声AIの設定の準備中です");
    const start = await readJson(request, 9_000_000) as StartRequest;
    if (typeof start.mode !== "string" || !["scene", "drill", "retell", "review", "whiteboard"].includes(start.mode)) throw new HttpError(400, "練習モードを選んでください");
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND status IN ('created', 'active')")
      .bind(user.id).first<{ count: number }>();
    if ((count?.count ?? 0) >= 1) throw new HttpError(409, "接続中のレッスンがあります。履歴から終了して、もう一度お試しください。");
    const id = crypto.randomUUID();
    return env.LESSONS.get(env.LESSONS.idFromName(id)).fetch("https://lesson.internal/initialize", {
      method: "POST", body: JSON.stringify({ id, userId: user.id, request: start }),
    });
  }
  if (url.pathname === "/api/session/stop" && request.method === "POST") {
    const body = await readJson(request);
    if (typeof body.session_id !== "string") throw new HttpError(400, "セッションを指定してください");
    await ownedSession(env.DB, user.id, body.session_id);
    return lessonRequest(env, user, body.session_id, "/end");
  }
  const connect = /^\/api\/session\/([a-f0-9-]{36})\/connect$/.exec(url.pathname);
  if (connect && request.method === "POST") {
    await ownedSession(env.DB, user.id, connect[1]!);
    return lessonRequest(env, user, connect[1]!, "/ticket");
  }
  const socket = /^\/ws\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (socket && request.method === "GET") {
    await ownedSession(env.DB, user.id, socket[1]!);
    const headers = new Headers(request.headers);
    headers.set("X-User-Id", user.id);
    return env.LESSONS.get(env.LESSONS.idFromName(socket[1]!))
      .fetch(new Request(`https://lesson.internal/socket${url.search}`, { headers }));
  }
  if (url.pathname === "/api/history" && request.method === "GET") {
    const cursor = url.searchParams.get("before");
    let before = Date.now() + 1, beforeId = "";
    if (cursor) {
      const match = /^(\d+):([a-f0-9-]{36})$/.exec(cursor);
      if (!match) throw new HttpError(400, "Invalid cursor");
      before = Number(match[1]); beforeId = match[2]!;
      if (!Number.isSafeInteger(before)) throw new HttpError(400, "Invalid cursor");
    }
    const page = await env.DB.prepare(`SELECT id, mode, label, started_at, ended_at, status, recording_status
      FROM sessions WHERE user_id = ? AND (started_at < ? OR (started_at = ? AND id < ?))
      ORDER BY started_at DESC, id DESC LIMIT 31`).bind(user.id, before, before, beforeId).all();
    const items = page.results.slice(0, 30);
    const last = items.at(-1);
    return json({ sessions: items, next: page.results.length > 30 && last ? `${last.started_at}:${last.id}` : null });
  }
  const history = /^\/api\/history\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (history && request.method === "GET") {
    const session = await ownedSession(env.DB, user.id, history[1]!);
    const [turns, notes, recording] = await Promise.all([
      env.DB.prepare("SELECT id, role, text, at FROM turns WHERE session_id = ? ORDER BY seq").bind(session.id).all(),
      env.DB.prepare("SELECT payload FROM notes WHERE session_id = ? ORDER BY seq").bind(session.id).all<{ payload: string }>(),
      env.DB.prepare("SELECT expires_at FROM recordings WHERE session_id = ? AND status = 'ready' AND expires_at > ?")
        .bind(session.id, Date.now()).first<{ expires_at: number }>(),
    ]);
    return json({ session, turns: turns.results.map(turn => ({ ...turn, done: true })), notes: notes.results.map(note => JSON.parse(note.payload)),
      recording: recording ? { url: `/api/recordings/${session.id}`, expiresAt: recording.expires_at } : null });
  }
  const audio = /^\/api\/recordings\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (audio) {
    await ownedSession(env.DB, user.id, audio[1]!);
    if (request.method === "POST") return uploadRecording(request, env, user, audio[1]!);
    if (request.method === "GET") {
      const record = await env.DB.prepare("SELECT * FROM recordings WHERE session_id = ? AND status = 'ready' AND expires_at > ?")
        .bind(audio[1]!, Date.now()).first<RecordingRow>();
      if (!record) throw new HttpError(404, "録音は保存されていないか、保存期間が終了しました");
      const object = await env.RECORDINGS.get(record.object_key, { range: request.headers });
      if (!object) throw new HttpError(404, "録音の保存期間が終了しました");
      const headers = new Headers({
        "Content-Type": record.content_type ?? "application/octet-stream",
        "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
      });
      if (object.range && "offset" in object.range && "length" in object.range) {
        headers.set("Content-Range", `bytes ${object.range.offset}-${object.range.offset! + object.range.length! - 1}/${object.size}`);
        headers.set("Content-Length", String(object.range.length));
      } else headers.set("Content-Length", String(object.size));
      return new Response(object.body, { status: object.range ? 206 : 200, headers });
    }
  }
  throw new HttpError(404, "Not found");
}

async function lessonRequest(env: Env, user: Identity, id: string, path: string): Promise<Response> {
  return env.LESSONS.get(env.LESSONS.idFromName(id)).fetch(`https://lesson.internal${path}`, { method: "POST", headers: { "X-User-Id": user.id } });
}

async function uploadRecording(request: Request, env: Env, user: Identity, id: string): Promise<Response> {
  const bytes = await limitedBody(request, MAX_RECORDING_BYTES);
  const contentType = compressedAudioType(request.headers.get("content-type"), bytes);
  if (!contentType) throw new HttpError(415, "圧縮した音声ファイルを送ってください");
  const reservation = await (await progressRequest(env, user.id, "/begin-upload", { sessionId: id, bytes: bytes.byteLength }))
    .json<{ key: string; expiresAt: number }>();
  try {
    await env.RECORDINGS.put(reservation.key, bytes, {
      httpMetadata: { contentType },
      customMetadata: { expiresAt: String(reservation.expiresAt), sessionId: id },
    });
    const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    await progressRequest(env, user.id, "/finish-upload", { sessionId: id, bytes: bytes.byteLength, contentType, sha256 });
    return json({ saved: true, expiresAt: reservation.expiresAt });
  } catch (error) {
    // 書き込み後に期限切れ処理が走った場合も、孤立したオブジェクトを残さない。
    const current = await env.DB.prepare("SELECT status FROM recordings WHERE session_id = ?").bind(id).first<{ status: string }>();
    if (current?.status !== "ready") {
      await env.RECORDINGS.delete(reservation.key);
      await progressRequest(env, user.id, "/delete-recording", { sessionId: id, cancel: true });
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); } catch (error) { return errorResponse(error); }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const expired = await env.DB.prepare(`SELECT session_id, user_id FROM recordings WHERE
        (status = 'ready' AND expires_at <= ?) OR (status IN ('reserved', 'uploading') AND reserved_until <= ?) LIMIT 100`)
        .bind(Date.now(), Date.now()).all<{ session_id: string; user_id: string }>();
      const results = await Promise.allSettled(expired.results.map(record =>
        progressRequest(env, record.user_id, "/delete-recording", { sessionId: record.session_id })));
      if (results.some(result => result.status === "rejected")) throw new Error("Some expired recordings could not be deleted; next run will retry");
    })());
  },
} satisfies ExportedHandler<Env>;
