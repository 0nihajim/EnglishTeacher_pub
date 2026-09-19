import type { ClientMessage, ControlAction, Mode, ServerMessage, StartRequest, TurnTaking, UiMessage } from "../../shared/messages";
import { Session, type SessionCheckpoint } from "../../server/src/session";
import { buildPlan, type PlanRequest } from "../../server/src/modes";
import { GeminiLiveBridge } from "../../server/src/gemini";
import { GeminiAnalyst } from "../../server/src/flash";
import { GoogleGenAI } from "@google/genai";
import type { ResultRow } from "../../server/src/results";
import { MAX_FRAME_BYTES, parseLearnerImage } from "../../server/src/image";
import { dailyReview, isNote, readResults, saveNote, saveTurn, scenes } from "./store";
import { progressRequest } from "./user-progress";
import { errorResponse, HttpError, json, readJson } from "./http";

interface Metadata {
  id: string;
  userId: string;
  startedAt: number;
  closed: boolean;
  endedAt?: number;
  endStatus?: "ended" | "interrupted" | "failed";
  turnTaking: TurnTaking;
  request: Exclude<PlanRequest, { mode: "retell" }> | { mode: "retell"; imageKey: string; imageType: string };
  sequence: number;
  ticketHash?: string;
  ticketExpires?: number;
}

type Pending =
  | { kind: "message"; seq: number; at: number; message: ServerMessage }
  | { kind: "result"; seq: number; sceneId: string; row: ResultRow };

const CONTROLS = new Set<ControlAction>(["skip", "hint", "next", "retry"]);
const RECONNECT_GRACE_MS = 60_000;
/** 板のフレーム以外の1通の上限。マイク音声の断片でも数KBに収まる。 */
const MAX_MESSAGE_CHARS = 32_000;
/**
 * 板のフレーム(ボード)1通の上限。長辺768pxの白地JPEGは30〜100KBで、base64にすると4/3倍になる。
 * 中身の検査(復号して 1MB 以下)は共有の Session が持つので、ここは明らかに大きすぎる通だけ切る。
 */
const MAX_FRAME_CHARS = Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 1_000;

/**
 * ブラウザから来た1通を読む。読めない・大きすぎるときは null を返し、呼び出し側がソケットを切る。
 * 上限は種類で違う: 板のフレームだけ base64 の画像が載る。ボード以外のモードではその大きさを
 * 許さないので、他のモードの入口が広がることはない。
 */
export function readClientMessage(data: string | ArrayBuffer, mode: Mode): ClientMessage | null {
  const ceiling = mode === "whiteboard" ? MAX_FRAME_CHARS : MAX_MESSAGE_CHARS;
  if (typeof data !== "string" || data.length > ceiling) return null;
  let message: ClientMessage;
  try { message = JSON.parse(data) as ClientMessage; } catch { return null; }
  if (!message || typeof message !== "object") return null;
  if (data.length > MAX_MESSAGE_CHARS && message.type !== "board_frame") return null;
  return message;
}

export class LessonSession {
  private meta: Metadata | null = null;
  private runtime: Session | null = null;
  private socket: WebSocket | null = null;
  private writes: Promise<void> = Promise.resolve();
  private ending: Promise<void> | null = null;
  private latestUi = new Map<string, UiMessage>();
  private buffered = new Map<string, Pending>();
  private disconnectedAt: number | null = null;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      await this.load();
      const path = new URL(request.url).pathname;
      if (path === "/initialize") return await this.initialize(await readJson(request, 9_000_000));
      if (!this.meta || this.meta.userId !== request.headers.get("X-User-Id")) throw new HttpError(404, "セッションが見つかりません");
      if (path === "/end") {
        await this.finish("ended");
        return json({ ok: true });
      }
      if (this.meta.closed) throw new HttpError(410, "このセッションは終了しました");
      if (path === "/ticket") {
        const ticket = await this.issueTicket();
        return json({ ws_path: `/ws/${this.meta.id}?ticket=${ticket}` });
      }
      if (path === "/socket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") return await this.connect(request);
      throw new HttpError(404, "Not found");
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async load(): Promise<void> {
    if (this.meta) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.meta = await this.ctx.storage.get<Metadata>("meta") ?? null;
      const ui = await this.ctx.storage.get<UiMessage[]>("ui");
      this.latestUi = new Map((ui ?? []).map(message => [message.widget, message]));
      await this.flushPending();
    });
  }

  private async initialize(body: Record<string, unknown>): Promise<Response> {
    if (this.meta) throw new HttpError(409, "セッションは作成済みです");
    if (typeof body.id !== "string" || typeof body.userId !== "string") throw new HttpError(400, "Invalid session");
    const start = body.request as StartRequest;
    let request: Metadata["request"];
    if (start.mode === "retell") {
      const image = parseLearnerImage(start.image);
      const imageKey = `images/${body.userId}/${body.id}`;
      await this.env.RECORDINGS.put(imageKey, Buffer.from(image.data, "base64"), { httpMetadata: { contentType: image.mimeType } });
      request = { mode: "retell", imageKey, imageType: image.mimeType };
    } else if (start.mode === "review") {
      const { cards } = await dailyReview(this.env.DB, body.userId);
      if (!cards.length) throw new HttpError(409, "今は復習する課題がありません");
      request = { mode: "review", cards };
    } else if (start.mode === "whiteboard") {
      // 板は接続後に board_frame で届く。開くのに要るものは無い。
      request = { mode: "whiteboard" };
    } else {
      const scene = scenes.find(candidate => candidate.id === start.scene_id);
      if (!scene) throw new HttpError(400, "シーンを選んでください");
      request = { mode: start.mode === "drill" ? "drill" : "scene", scene };
    }
    this.meta = {
      id: body.id, userId: body.userId, request,
      startedAt: Date.now(), closed: false, sequence: 0,
      turnTaking: request.mode === "review" || request.mode === "retell" || start.turn_taking === "manual" ? "manual" : "auto",
    };
    const label = request.mode === "retell" ? "話し直し" : request.mode === "review" ? "今日の復習"
      : request.mode === "whiteboard" ? "ボード" : request.scene.title;
    await this.ctx.storage.put("meta", this.meta);
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    try {
      await this.env.DB.prepare(`INSERT INTO sessions (id, user_id, mode, label, started_at, model) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(this.meta.id, this.meta.userId, request.mode, label, this.meta.startedAt, this.env.GEMINI_LIVE_MODEL).run();
    } catch (error) {
      this.meta.closed = true;
      this.meta.endedAt = Date.now();
      this.meta.endStatus = "failed";
      await this.ctx.storage.put("meta", this.meta);
      if (request.mode === "retell") await this.env.RECORDINGS.delete(request.imageKey);
      if (error instanceof Error && /UNIQUE constraint failed: sessions\.user_id/.test(error.message)) {
        throw new HttpError(409, "接続中のレッスンがあります。履歴から終了してください。");
      }
      throw error;
    }
    const ticket = await this.issueTicket();
    let recording = { enabled: false, maxBytes: 0 };
    try {
      recording = await (await progressRequest(this.env, this.meta.userId, "/reserve", { sessionId: this.meta.id })).json();
    } catch {
      // 録音保存の準備が失敗しても、会話・スクリプト・採点は使える。
      console.warn("Recording reservation unavailable; continuing with text storage");
    }
    return json({
      session_id: this.meta.id, ws_path: `/ws/${this.meta.id}?ticket=${ticket}`,
      resume_path: `/api/session/${this.meta.id}/connect`,
      mode: request.mode, turn_taking: this.meta.turnTaking, recording,
      ...("scene" in request ? { scene_title: request.scene.title } : {}),
    }, 201);
  }

  private async issueTicket(): Promise<string> {
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    this.meta!.ticketHash = await digest(ticket);
    this.meta!.ticketExpires = Date.now() + 60_000;
    await this.ctx.storage.put("meta", this.meta);
    return ticket;
  }

  private async connect(request: Request): Promise<Response> {
    const meta = this.meta!;
    await this.ctx.blockConcurrencyWhile(async () => {
      const ticket = new URL(request.url).searchParams.get("ticket");
      if (!ticket || ticket.length > 200 || !meta.ticketHash || (meta.ticketExpires ?? 0) <= Date.now() ||
          await digest(ticket) !== meta.ticketHash) throw new HttpError(403, "接続の有効期限が切れました");
      if (this.socket) throw new HttpError(409, "別の端末で接続中です");
      delete meta.ticketHash;
      delete meta.ticketExpires;
      await this.ctx.storage.put("meta", meta);
      if (!this.runtime) await this.createRuntime();
    });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.socket = server;
    this.disconnectedAt = null;
    server.addEventListener("message", event => this.onMessage(server, event.data));
    server.addEventListener("close", event => {
      if (this.socket !== server) return;
      this.runtime?.detachFrontend(server);
      this.socket = null;
      if (event.code === 1000) this.ctx.waitUntil(this.finish("ended"));
      else {
        this.runtime?.suspendInput();
        this.disconnectedAt = Date.now();
        this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS));
      }
    });
    server.addEventListener("error", () => {
      try { server.close(1011, "connection error"); } catch { /* already closed */ }
    });
    this.runtime!.tryAttachFrontend(server);
    const oldTurns = await this.env.DB.prepare("SELECT id, role, text FROM turns WHERE session_id = ? ORDER BY seq").bind(meta.id)
      .all<{ id: string; role: "user" | "assistant"; text: string }>();
    for (const turn of oldTurns.results) server.send(JSON.stringify({ type: "turn", ...turn, done: true }));
    for (const message of this.latestUi.values()) server.send(JSON.stringify({ type: "ui", ...message }));
    await this.env.DB.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").bind(meta.id).run();
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    this.runtime!.start();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async createRuntime(): Promise<void> {
    const meta = this.meta!;
    let request: PlanRequest;
    if (meta.request.mode === "retell") {
      const image = await this.env.RECORDINGS.get(meta.request.imageKey);
      if (!image) throw new HttpError(410, "このセッションの画像がありません");
      request = { mode: "retell", image: parseLearnerImage({ data: Buffer.from(await image.arrayBuffer()).toString("base64") }) };
    } else request = meta.request;
    const plan = await buildPlan(request, {
      read: sceneId => readResults(this.env.DB, meta.userId, sceneId),
      append: async (sceneId, rows) => {
        for (const row of rows) this.queue({ kind: "result", seq: ++meta.sequence, sceneId, row });
        await this.writes;
      },
    }, new GeminiAnalyst(this.env.GEMINI_FLASH_MODEL, new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY })));
    const checkpoint = await this.ctx.storage.get<SessionCheckpoint>("checkpoint");
    this.runtime = new Session(meta.id, plan, meta.turnTaking,
      () => this.ctx.waitUntil(this.finish("failed")),
      (...args) => new GeminiLiveBridge(...args),
      { onMessage: message => this.observe(message) },
      checkpoint,
    );
  }

  private onMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (socket !== this.socket || !this.runtime || !this.meta || this.meta.closed) return;
    const message = readClientMessage(data, this.meta.request.mode);
    if (!message) { socket.close(1008, "invalid message"); return; }
    if (message.type === "mic_audio") {
      if (typeof message.audio !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.audio)) { socket.close(1008, "invalid audio"); return; }
      this.runtime.sendMicAudio(message.audio);
    } else if (message.type === "mic_end") this.runtime.endMicStream();
    else if (message.type === "speech_start") this.runtime.startSpeech();
    else if (message.type === "speech_end") this.runtime.endSpeech();
    else if (message.type === "control" && CONTROLS.has(message.action)) this.runtime.control(message.action);
    // 中身の検査(1MB上限)と1枚/秒の間引きは共有の Session が持つ。ここは渡すだけ。
    else if (message.type === "board_frame") this.runtime.boardFrame(message, typeof message.seq === "number" ? message.seq : 0);
  }

  private observe(message: ServerMessage): void {
    if (message.type === "ui") this.latestUi.set(message.widget, message);
    if ((message.type === "turn" && message.done) || isNote(message)) {
      this.queue({ kind: "message", seq: ++this.meta!.sequence, at: Date.now(), message });
    } else if (message.type === "ui") {
      this.writes = this.writes.then(() => this.saveCheckpoint()).catch(() => this.persistenceFailed());
      this.ctx.waitUntil(this.writes);
    }
  }

  private queue(pending: Pending): void {
    const key = `pending/${String(pending.seq).padStart(12, "0")}`;
    this.buffered.set(key, pending);
    this.writes = this.writes.then(async () => {
      await this.saveCheckpoint();
      await this.persist(pending);
      await this.ctx.storage.delete(key);
    }).catch(() => this.persistenceFailed());
    this.ctx.waitUntil(this.writes);
  }

  private async saveCheckpoint(): Promise<void> {
    const checkpoint = this.runtime?.checkpoint();
    const buffered = [...this.buffered];
    // 進行状態と、その状態までに生まれた全イベントを同じ原子的書き込みに含める。
    // D1待ちの間に次の採点へ進んでも、結果のないチェックポイントを残さない。
    await this.ctx.storage.put({
      ...Object.fromEntries(buffered),
      meta: this.meta,
      ui: [...this.latestUi.values()],
      ...(checkpoint ? { checkpoint } : {}),
    });
    for (const [key] of buffered) this.buffered.delete(key);
  }

  private async persist(pending: Pending): Promise<void> {
    const meta = this.meta!;
    if (pending.kind === "result") {
      await progressRequest(this.env, meta.userId, "/result", {
        eventId: pending.row.kind === "review" ? pending.row.eventId : `${meta.id}:${pending.seq}`,
        sceneId: pending.sceneId, sessionId: meta.id, row: pending.row,
      });
    } else if (pending.message.type === "turn") {
      await saveTurn(this.env.DB, meta.id, pending.message, pending.seq, pending.at);
    } else if (pending.message.type === "ui") {
      await saveNote(this.env.DB, meta.id, pending.message, pending.seq, pending.at);
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.meta) return;
    if (this.buffered.size) await this.saveCheckpoint();
    const pending = await this.ctx.storage.list<Pending>({ prefix: "pending/" });
    for (const [key, event] of pending) {
      await this.persist(event);
      await this.ctx.storage.delete(key);
    }
  }

  private async persistenceFailed(): Promise<void> {
    console.error("Learning data write pending; retry scheduled");
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: "notice", message: "学習記録の保存を再試行しています" }));
  }

  private finish(status: "ended" | "interrupted" | "failed"): Promise<void> {
    if (this.ending) return this.ending;
    this.ending = (async () => {
      if (!this.meta) return;
      this.meta.closed = true;
      this.meta.endedAt ??= Date.now();
      this.meta.endStatus ??= status;
      // D1が一時的に失敗しても、alarmが終了処理を再開できるよう先に残す。
      await this.ctx.storage.put("meta", this.meta);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
      await this.runtime?.stop();
      this.socket = null;
      await this.writes;
      await this.finalize();
    })().finally(() => { this.ending = null; });
    return this.ending;
  }

  private async finalize(): Promise<void> {
    if (!this.meta?.closed) return;
    await this.flushPending();
    await this.env.DB.prepare("UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?")
      .bind(this.meta.endStatus ?? "interrupted", this.meta.endedAt ?? Date.now(), this.meta.id).run();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.load();
    if (!this.meta) return;
    await this.writes;
    await this.flushPending();
    if (this.meta.closed) { await this.finalize(); return; }
    const now = Date.now();
    const timedOut = now - this.meta.startedAt >= Number(this.env.MAX_SESSION_SECONDS) * 1000;
    const idle = !this.runtime || now - this.runtime.lastActivityAt >= RECONNECT_GRACE_MS;
    const disconnected = this.disconnectedAt !== null && now - this.disconnectedAt >= RECONNECT_GRACE_MS;
    if (timedOut || idle || disconnected) await this.finish("interrupted");
    else await this.ctx.storage.setAlarm(now + RECONNECT_GRACE_MS);
  }
}

async function digest(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
}
