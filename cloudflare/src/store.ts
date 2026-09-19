import type { DailyReviewPlan, ServerMessage, Turn, UiMessage } from "../../shared/messages";
import type { ResultRow } from "../../server/src/results";
import { buildReviewCards, REVIEW_LIMIT, type ReviewCard } from "../../server/src/review";
import { bundledScenes } from "../../server/src/generated/content";
import { parseScene } from "../../server/src/scene-schema";
import type { Identity } from "./auth";
import { HttpError } from "./http";

export const scenes = bundledScenes.map(({ id, data }) => parseScene(data, id));

export async function ensureUser(db: D1Database, user: Identity): Promise<void> {
  await db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(user.id, user.email, Date.now()).run();
}

export interface SessionRow {
  id: string; user_id: string; mode: string; label: string; started_at: number;
  ended_at: number | null; status: string; recording_status: string; model: string;
}

export async function ownedSession(db: D1Database, userId: string, id: string): Promise<SessionRow> {
  const session = await db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ?").bind(id, userId).first<SessionRow>();
  if (!session) throw new HttpError(404, "履歴が見つかりません");
  return session;
}

export async function readResults(db: D1Database, userId: string, sceneId: string): Promise<ResultRow[]> {
  const all: ResultRow[] = [];
  let at = -1, eventId = "";
  for (;;) {
    const page = await db.prepare(`SELECT payload, at, event_id FROM results
      WHERE user_id = ? AND scene_id = ? AND (at > ? OR (at = ? AND event_id > ?))
      ORDER BY at, event_id LIMIT 500`).bind(userId, sceneId, at, at, eventId)
      .all<{ payload: string; at: number; event_id: string }>();
    for (const row of page.results) all.push(JSON.parse(row.payload) as ResultRow);
    const last = page.results.at(-1);
    if (!last || page.results.length < 500) return all;
    at = last.at;
    eventId = last.event_id;
  }
}

async function cardHistory(db: D1Database, userId: string, cardId: string): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  let eventId = "";
  for (;;) {
    const page = await db.prepare(`SELECT r.payload, r.event_id FROM result_cards c
      JOIN results r ON r.user_id = c.user_id AND r.event_id = c.event_id
      WHERE c.user_id = ? AND c.card_id = ? AND c.event_id > ?
      ORDER BY c.event_id LIMIT 500`).bind(userId, cardId, eventId).all<{ payload: string; event_id: string }>();
    for (const row of page.results) rows.push(JSON.parse(row.payload) as ResultRow);
    const last = page.results.at(-1);
    if (!last || page.results.length < 500) return rows;
    eventId = last.event_id;
  }
}

/** UserProgress が同じユーザーの書き込みを直列化してから呼ぶ。再配送でも一度だけ反映する。 */
export async function appendResult(
  db: D1Database, userId: string, sessionId: string | null, sceneId: string, eventId: string, row: ResultRow,
): Promise<void> {
  const payload = JSON.stringify(row);
  if (!Number.isFinite(Date.parse(row.at)) || payload.length > 200_000) throw new HttpError(400, "記録の形式が正しくありません");
  const old = await db.prepare("SELECT payload FROM results WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first<{ payload: string }>();
  if (old) {
    if (old.payload !== payload) throw new HttpError(409, "記録IDが重複しています");
    return;
  }
  if (sessionId) await ownedSession(db, userId, sessionId);
  const affected = buildReviewCards([row], scenes).map(card => card.id);
  const statements = [
    db.prepare("INSERT INTO results (user_id, event_id, session_id, scene_id, kind, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(userId, eventId, sessionId, sceneId, row.kind, Date.parse(row.at), payload),
  ];
  for (const id of affected) {
    // この課題に関係する履歴だけ再適用する。遅延した記録・インポートでも日時順の結果を保つ。
    const card = buildReviewCards([...await cardHistory(db, userId, id), row], scenes).find(candidate => candidate.id === id)!;
    statements.push(
      db.prepare("INSERT INTO result_cards (user_id, event_id, card_id) VALUES (?, ?, ?)").bind(userId, eventId, id),
      db.prepare(`INSERT INTO review_cards (user_id, id, due_at, lapses, last_review_at, payload)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET
        due_at = excluded.due_at, lapses = excluded.lapses, last_review_at = excluded.last_review_at, payload = excluded.payload`)
        .bind(userId, id, card.dueAt, card.lapses, card.lastReviewAt ?? null, JSON.stringify(card)),
    );
  }
  await db.batch(statements);
}

export async function dailyReview(db: D1Database, userId: string, now = Date.now()): Promise<{ plan: DailyReviewPlan; cards: ReviewCard[] }> {
  const [totals, dueRows, next, recent] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(due_at <= ?), 0) AS due FROM review_cards WHERE user_id = ?")
      .bind(now, userId).first<{ total: number; due: number }>(),
    db.prepare("SELECT payload FROM review_cards WHERE user_id = ? AND due_at <= ? ORDER BY due_at, lapses DESC, id LIMIT ?")
      .bind(userId, now, REVIEW_LIMIT).all<{ payload: string }>(),
    db.prepare("SELECT MIN(due_at) AS at FROM review_cards WHERE user_id = ? AND due_at > ?")
      .bind(userId, now).first<{ at: number | null }>(),
    db.prepare(`SELECT r.payload FROM results r WHERE user_id = ? AND kind = 'review' AND at >= ? AND at <= ?
      AND EXISTS (SELECT 1 FROM result_cards c WHERE c.user_id = r.user_id AND c.event_id = r.event_id)`)
      .bind(userId, now - 36 * 3600_000, now).all<{ payload: string }>(),
  ]);
  const cards = dueRows.results.map(row => JSON.parse(row.payload) as ReviewCard);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
  const today = date.format(now);
  const practiced = new Set(recent.results.flatMap(({ payload }) => {
    const row = JSON.parse(payload) as ResultRow;
    return row.kind === "review" && row.outcome !== "skipped" && date.format(Date.parse(row.at)) === today ? [row.card.id] : [];
  }));
  return {
    cards,
    plan: {
      total: totals?.total ?? 0, due: totals?.due ?? 0, practicedToday: practiced.size,
      estimatedMinutes: cards.length * 3,
      ...(next?.at ? { nextDueAt: new Date(next.at).toISOString() } : {}),
      items: cards.map(({ id, cue, kind, source }) => ({ id, cue, kind, source })),
    },
  };
}

export function isNote(message: ServerMessage): boolean {
  if (message.type !== "ui") return false;
  return ["recast", "drill_answer", "retell_review", "retell_compare"].includes(message.widget) ||
    (message.widget === "review_step" && message.props.phase === "done");
}

export async function saveTurn(db: D1Database, sessionId: string, turn: Turn, seq: number, at: number): Promise<void> {
  await db.prepare(`INSERT INTO turns (session_id, id, seq, role, text, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO NOTHING`).bind(sessionId, turn.id, seq, turn.role, turn.text, at).run();
}

export async function saveNote(db: D1Database, sessionId: string, message: UiMessage, seq: number, at: number): Promise<void> {
  await db.prepare(`INSERT INTO notes (session_id, id, seq, payload, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO NOTHING`).bind(sessionId, `note_${seq}`, seq, JSON.stringify(message), at).run();
}
