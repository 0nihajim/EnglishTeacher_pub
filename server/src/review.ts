import { createHash } from "node:crypto";
import type { DailyReviewPlan, ReviewOutcome, ReviewSeed, TeachingNotes } from "../../shared/messages";
import { feedbackText, isRecord, parseTeachingNotes } from "./feedback";
import { normalizeTerm } from "./modes/match";
import type { ResultRow } from "./results";
import type { Scene } from "./scenes";

export const DAY_MS = 86_400_000;
export const REVIEW_LIMIT = 3;
/** 学習上の推奨値の断定ではなく、このアプリの初期スケジュール。 */
const INTERVAL_DAYS = [1, 3, 7, 14, 30] as const;
const OUTCOMES: readonly ReviewOutcome[] = ["independent", "repaired", "hinted", "modeled", "again", "skipped"];

export interface ReviewCard extends ReviewSeed {
  dueAt: number;
  level: number;
  lapses: number;
  lastReviewAt?: number;
}

function seed(input: Omit<ReviewSeed, "id">): ReviewSeed {
  const key = input.kind === "expression"
    ? input.answer
    : `${input.cue}|${input.original ?? ""}|${input.answer}`;
  const id = createHash("sha256").update(`${input.kind}|${key.toLowerCase().replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 24);
  return { id, ...input };
}

function expression(teaching: TeachingNotes | undefined, source: string): ReviewSeed[] {
  if (!teaching?.collocation) return [];
  const { phrase, meaning, example } = teaching.collocation;
  // 既存ノートには「blocked by を使って」のような課題もある。
  // 表現そのものが見えた成功を、自力で思い出した成功に数えない。
  const meaningCue = meaning.split(/[。.!?]/)[0]!.replace(/[a-z][a-z' +/-]*/gi, "").trim() || "前回教わった意味";
  const practice = teaching.practice && !/[a-z]/i.test(teaching.practice)
    ? teaching.practice : `「${meaningCue}」という意味を、自分のことについて英語で伝えよう。`;
  return [seed({
    kind: "expression", cue: practice, answer: phrase, source,
    note: meaning, teaching: { ...teaching, collocation: { phrase, meaning, example } },
  })];
}

/** 古い・手編集された履歴も読むため、型を信頼せず必要な欄を検証する。 */
function observations(row: ResultRow, scenes: readonly Scene[]): { card: ReviewSeed; weak: boolean }[] {
  const source = row.kind === "retell" ? "話し直し" :
    "scene" in row ? (scenes.find((s) => s.id === row.scene)?.title ?? "過去の練習") : "過去の練習";
  const teaching = "teaching" in row ? parseTeachingNotes(row.teaching) : undefined;
  const cards: { card: ReviewSeed; weak: boolean }[] = [];
  if (row.kind === "drill") {
    const cue = feedbackText(row.ja), answer = feedbackText(row.en);
    if (cue && answer && ["correct", "close", "wrong", "skipped"].includes(row.verdict)) {
      cards.push({ card: seed({ kind: "translation", cue, answer, source, note: feedbackText(row.note) || undefined, teaching }), weak: row.verdict !== "correct" });
    }
  } else if (row.kind === "recast" && row.correctionKind !== "upgrade") {
    const original = feedbackText(row.original), answer = feedbackText(row.better);
    if (original && answer && original !== answer) {
      cards.push({ card: seed({
        kind: "repair", cue: "前回の文を、同じ意味で言い直そう。", original, answer,
        source, note: feedbackText(row.note) || undefined, teaching,
      }), weak: true });
    }
  } else if (row.kind === "retell" && Array.isArray(row.improvements)) {
    for (const imp of row.improvements.slice(0, 2)) {
      if (!isRecord(imp)) continue;
      const original = feedbackText(imp.original), answer = feedbackText(imp.better);
      if (original && answer && original !== answer) {
        cards.push({ card: seed({
          kind: "repair", cue: "前回の文を、同じ意味で言い直そう。", original, answer,
          source, note: feedbackText(imp.note) || undefined,
        }), weak: imp.used !== true });
      }
    }
  } else if (row.kind === "scene" && row.status !== "unused") {
    const scene = scenes.find((s) => s.id === row.scene);
    const target = scene?.targets.find((t) => normalizeTerm(t.term) === normalizeTerm(feedbackText(row.term)));
    if (target && ["modeled", "heard", "used_with_error", "used_well"].includes(row.status)) {
      cards.push({ card: seed({
        kind: "expression", cue: `「${target.meaning}」を、自分のことについて英語で伝えよう。`,
        answer: target.term, source, note: target.meaning,
        teaching: target.example ? { collocation: { phrase: target.term, meaning: target.meaning, example: target.example } } : undefined,
      }), weak: row.status !== "used_well" });
    }
  }
  cards.push(...expression(teaching, source).map((card) => ({ card, weak: false })));
  return cards;
}

function validStoredSeed(raw: unknown): ReviewSeed | null {
  if (!isRecord(raw) || !["translation", "repair", "expression"].includes(String(raw.kind))) return null;
  const cue = feedbackText(raw.cue), answer = feedbackText(raw.answer), source = feedbackText(raw.source);
  if (!cue || !answer || !source) return null;
  const parsed = seed({
    kind: raw.kind as ReviewSeed["kind"], cue, answer, source,
    ...(feedbackText(raw.original) ? { original: feedbackText(raw.original) } : {}),
    ...(feedbackText(raw.note) ? { note: feedbackText(raw.note) } : {}),
    ...(parseTeachingNotes(raw.teaching) ? { teaching: parseTeachingNotes(raw.teaching) } : {}),
  });
  return raw.id === parsed.id ? parsed : null;
}

/** 全履歴を日時順に適用する純粋関数。読み直しても復習間隔が延びたり戻ったりしない。 */
export function buildReviewCards(rows: readonly ResultRow[], scenes: readonly Scene[] = []): ReviewCard[] {
  const cards = new Map<string, ReviewCard>();
  const events = new Set<string>();
  const ordered = rows.filter((row) => Number.isFinite(Date.parse(row.at))).slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const row of ordered) {
    const at = Date.parse(row.at);
    if (row.kind === "review") {
      if (!row.eventId || events.has(row.eventId) || !OUTCOMES.includes(row.outcome)) continue;
      const stored = validStoredSeed(row.card);
      if (!stored) continue;
      events.add(row.eventId);
      let card = cards.get(stored.id);
      if (!card) {
        card = { ...stored, dueAt: at, level: 0, lapses: 0 };
        cards.set(card.id, card);
      }
      // 同じ課題を複数タブで同日に成功しても、間隔は一段ずつしか伸ばさない。
      if (row.outcome === "independent" && (card.lastReviewAt === undefined || at - card.lastReviewAt >= DAY_MS)) {
        card.level = Math.min(card.level + 1, INTERVAL_DAYS.length);
        card.dueAt = at + INTERVAL_DAYS[card.level - 1]! * DAY_MS;
      } else if (row.outcome !== "independent") {
        card.level = 0;
        card.lapses += 1;
        card.dueAt = at + (row.outcome === "again" || row.outcome === "skipped" ? 10 * 60_000 : DAY_MS);
      }
      card.lastReviewAt = at;
      continue;
    }
    for (const { card: observed, weak } of observations(row, scenes)) {
      const existing = cards.get(observed.id);
      if (!existing) {
        cards.set(observed.id, { ...observed, dueAt: at + (weak ? 0 : DAY_MS), level: 0, lapses: weak ? 1 : 0 });
      } else {
        Object.assign(existing, observed);
        if (weak) {
          existing.level = 0;
          existing.lapses += 1;
          existing.dueAt = Math.min(existing.dueAt, at);
        }
      }
    }
  }
  return [...cards.values()];
}

export function dailyReview(rows: readonly ResultRow[], scenes: readonly Scene[] = [], now = Date.now()): { plan: DailyReviewPlan; cards: ReviewCard[] } {
  const all = buildReviewCards(rows, scenes);
  const due = all.filter((c) => c.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || b.lapses - a.lapses || a.id.localeCompare(b.id));
  const cards = due.slice(0, REVIEW_LIMIT);
  const nextDue = all.filter((c) => c.dueAt > now).sort((a, b) => a.dueAt - b.dueAt)[0];
  const today = new Date(now).toDateString();
  const practiced = new Set(rows.filter((r) => r.kind === "review" && OUTCOMES.includes(r.outcome) && new Date(r.at).toDateString() === today &&
    r.outcome !== "skipped" && all.some((c) => c.id === r.card?.id)).map((r) => r.kind === "review" ? r.card.id : ""));
  return {
    cards,
    plan: {
      total: all.length, due: due.length, practicedToday: practiced.size,
      estimatedMinutes: cards.length * 3,
      ...(nextDue ? { nextDueAt: new Date(nextDue.dueAt).toISOString() } : {}),
      // 答え・訂正理由をここに入れない。復習前のホームで見えてしまうため。
      items: cards.map(({ id, cue, kind, source }) => ({ id, cue, kind, source })),
    },
  };
}
