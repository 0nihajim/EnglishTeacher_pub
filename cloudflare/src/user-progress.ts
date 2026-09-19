import type { ResultRow } from "../../server/src/results";
import { appendResult, ownedSession } from "./store";
import { errorResponse, HttpError, json, readJson } from "./http";
import { MAX_RECORDING_BYTES, recordingAdmission, recordingExpiresAt, UPLOAD_GRACE_MS } from "./recording-policy";

export class UserProgress {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const body = await readJson(request, 250_000);
      if (typeof body.userId !== "string" || !body.userId) throw new HttpError(400, "Missing owner");
      return await this.ctx.blockConcurrencyWhile(async () => {
        const owner = await this.ctx.storage.get<string>("owner");
        if (owner && owner !== body.userId) throw new HttpError(403, "Wrong owner");
        if (!owner) await this.ctx.storage.put("owner", body.userId);
        return this.route(new URL(request.url).pathname, body, body.userId as string);
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async route(path: string, body: Record<string, unknown>, userId: string): Promise<Response> {
    const db = this.env.DB;
    if (path === "/result") {
      if (typeof body.eventId !== "string" || typeof body.sceneId !== "string" ||
          !(body.sessionId === null || typeof body.sessionId === "string") || !body.row) throw new HttpError(400, "Invalid result");
      await appendResult(db, userId, body.sessionId, body.sceneId, body.eventId, body.row as ResultRow);
      return json({ ok: true });
    }
    if (typeof body.sessionId !== "string") throw new HttpError(400, "Missing session");
    const session = await ownedSession(db, userId, body.sessionId);
    if (path === "/reserve") {
      if (this.env.RECORDING_ENABLED !== "true" || !this.env.RECORDINGS) return json({ enabled: false });
      const existing = await db.prepare("SELECT status FROM recordings WHERE session_id = ?").bind(session.id).first<{ status: string }>();
      if (existing) return json({ enabled: existing.status === "reserved", maxBytes: MAX_RECORDING_BYTES });
      const budget = await db.prepare("SELECT * FROM recording_budget WHERE id = 1")
        .first<{ used_bytes: number; reserved_bytes: number; paused: number }>();
      if (!budget) throw new Error("Missing recording budget");
      const admission = recordingAdmission(budget.used_bytes, budget.reserved_bytes, Number(this.env.RECORDING_BUDGET_BYTES), !!budget.paused);
      if (!admission.allowed) {
        await db.prepare("UPDATE recording_budget SET paused = ? WHERE id = 1").bind(Number(admission.paused)).run();
        return json({ enabled: false });
      }
      const until = session.started_at + Number(this.env.MAX_SESSION_SECONDS) * 1000 + UPLOAD_GRACE_MS;
      await db.batch([
        db.prepare("UPDATE recording_budget SET reserved_bytes = reserved_bytes + ?, paused = 0 WHERE id = 1").bind(MAX_RECORDING_BYTES),
        db.prepare(`INSERT INTO recordings (session_id, user_id, object_key, status, reserved_bytes, reserved_until, expires_at)
          VALUES (?, ?, ?, 'reserved', ?, ?, ?)`).bind(session.id, userId, `recordings/${userId}/${session.id}`, MAX_RECORDING_BYTES, until, recordingExpiresAt(until)),
        db.prepare("UPDATE sessions SET recording_status = 'reserved' WHERE id = ?").bind(session.id),
      ]);
      return json({ enabled: true, maxBytes: MAX_RECORDING_BYTES });
    }
    if (path === "/begin-upload") {
      const recording = await db.prepare("SELECT * FROM recordings WHERE session_id = ?").bind(session.id).first<RecordingRow>();
      if (!recording || recording.status !== "reserved" || recording.reserved_until <= Date.now()) throw new HttpError(409, "録音の保存受付は終了しました");
      if (typeof body.bytes !== "number" || body.bytes <= 0 || body.bytes > recording.reserved_bytes) throw new HttpError(413, "録音が大きすぎます");
      const expires = recordingExpiresAt(session.ended_at ?? Date.now());
      await db.prepare("UPDATE recordings SET status = 'uploading', expires_at = ? WHERE session_id = ?").bind(expires, session.id).run();
      return json({ key: recording.object_key, expiresAt: expires });
    }
    if (path === "/finish-upload") {
      const recording = await db.prepare("SELECT * FROM recordings WHERE session_id = ?").bind(session.id).first<RecordingRow>();
      if (!recording) throw new HttpError(404, "録音が見つかりません");
      if (recording.status === "ready") return json({ ok: true });
      if (recording.status !== "uploading" || typeof body.bytes !== "number" || body.bytes <= 0 || body.bytes > recording.reserved_bytes ||
          typeof body.contentType !== "string" || typeof body.sha256 !== "string") throw new HttpError(409, "録音を保存できません");
      await db.batch([
        db.prepare("UPDATE recordings SET status = 'ready', size_bytes = ?, content_type = ?, sha256 = ? WHERE session_id = ?")
          .bind(body.bytes, body.contentType, body.sha256, session.id),
        db.prepare("UPDATE recording_budget SET reserved_bytes = reserved_bytes - ?, used_bytes = used_bytes + ? WHERE id = 1")
          .bind(recording.reserved_bytes, body.bytes),
        db.prepare("UPDATE sessions SET recording_status = 'available' WHERE id = ?").bind(session.id),
      ]);
      return json({ ok: true });
    }
    if (path === "/delete-recording") {
      const recording = await db.prepare("SELECT * FROM recordings WHERE session_id = ?").bind(session.id).first<RecordingRow>();
      if (!recording || recording.status === "deleted") return json({ ok: true });
      const expired = recording.status === "ready" ? recording.expires_at <= Date.now() : recording.reserved_until <= Date.now();
      if (!expired && body.cancel !== true) return json({ ok: true });
      // 削除済みのオブジェクトでも成功する。削除できるまで容量を解放しない。
      if (this.env.RECORDINGS) await this.env.RECORDINGS.delete(recording.object_key);
      await db.batch([
        db.prepare(`UPDATE recording_budget SET used_bytes = MAX(0, used_bytes - ?),
          reserved_bytes = MAX(0, reserved_bytes - ?) WHERE id = 1`)
          .bind(recording.status === "ready" ? recording.size_bytes : 0, recording.status === "ready" ? 0 : recording.reserved_bytes),
        db.prepare("UPDATE recordings SET status = 'deleted' WHERE session_id = ?").bind(session.id),
        db.prepare("UPDATE sessions SET recording_status = ? WHERE id = ?").bind(recording.status === "ready" ? "expired" : "not_saved", session.id),
      ]);
      return json({ ok: true });
    }
    throw new HttpError(404, "Not found");
  }
}

export interface RecordingRow {
  session_id: string; user_id: string; object_key: string; status: string;
  reserved_bytes: number; reserved_until: number; expires_at: number;
  size_bytes: number; content_type: string | null; sha256: string | null;
}

export async function progressRequest(env: Env, userId: string, path: string, payload: object): Promise<Response> {
  const response = await env.PROGRESS.get(env.PROGRESS.idFromName(userId)).fetch(`https://progress.internal${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, userId }),
  });
  if (!response.ok) {
    const body = await response.json() as { error?: string };
    throw new HttpError(response.status, body.error ?? "保存に失敗しました");
  }
  return response;
}
