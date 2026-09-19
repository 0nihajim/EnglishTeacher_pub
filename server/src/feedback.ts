import type { AssessmentCriterion, AssessmentItem, TeachingNotes } from "../../shared/messages";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function feedbackText(value: unknown, max = 240): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function parseTeachingNotes(raw: unknown): TeachingNotes | undefined {
  if (!isRecord(raw)) return undefined;
  const notes: TeachingNotes = {};
  if (isRecord(raw.alternative)) {
    const phrase = feedbackText(raw.alternative.phrase);
    const usage = feedbackText(raw.alternative.usage);
    if (phrase && usage) notes.alternative = { phrase, usage };
  }
  if (isRecord(raw.collocation)) {
    const phrase = feedbackText(raw.collocation.phrase, 100);
    const meaning = feedbackText(raw.collocation.meaning, 160);
    const example = feedbackText(raw.collocation.example);
    if (phrase && meaning && example) notes.collocation = { phrase, meaning, example };
  }
  const practice = feedbackText(raw.practice, 160);
  if (practice) notes.practice = practice;
  return Object.keys(notes).length ? notes : undefined;
}

/** Live の引数は平坦な文字列のままにし、表示用の型に変換する。 */
export function teachingFromTool(args: Record<string, unknown>): TeachingNotes | undefined {
  return parseTeachingNotes({
    alternative: { phrase: args.alternative, usage: args.alternative_note },
    collocation: { phrase: args.collocation, meaning: args.collocation_note, example: args.collocation_example },
    practice: args.practice,
  });
}

const CRITERIA: readonly AssessmentCriterion[] = ["meaning", "grammar", "naturalness", "range"];

export function parseAssessment(raw: unknown, transcript: string): AssessmentItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = new Map<AssessmentCriterion, AssessmentItem>();
  const source = feedbackText(transcript, 8_000).toLowerCase();
  for (const value of raw) {
    if (!isRecord(value) || !CRITERIA.includes(value.criterion as AssessmentCriterion)) continue;
    const criterion = value.criterion as AssessmentCriterion;
    if (items.has(criterion)) continue;
    const reason = feedbackText(value.reason);
    if (!reason) continue;
    const evidence = feedbackText(value.evidence, 200);
    const supported = evidence.length > 0 && source.includes(evidence.toLowerCase());
    const validScore = typeof value.score === "number" && Number.isInteger(value.score) &&
      value.score >= 1 && value.score <= 5;
    items.set(criterion, {
      criterion,
      score: supported && validScore ? value.score as AssessmentItem["score"] : null,
      evidence: supported ? evidence : "",
      reason: supported || value.score === null ? reason : "発話に対応する根拠が不足しているため、採点を見送りました。",
    });
  }
  return items.size ? CRITERIA.flatMap((criterion) => items.has(criterion) ? [items.get(criterion)!] : []) : undefined;
}

export const TEACHING_SCHEMA = {
  type: "object",
  properties: {
    alternative: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "One alternative English sentence preserving the learner's intended meaning." },
        usage: { type: "string", description: "Japanese: when to choose this alternative; tone, emphasis, or register. Do not label correct English as wrong." },
      },
      required: ["phrase", "usage"],
    },
    collocation: {
      type: "object",
      properties: {
        phrase: { type: "string", description: "One common reusable collocation or construction, e.g. make progress on + noun." },
        meaning: { type: "string", description: "Japanese meaning and usage; include the needed preposition or object pattern." },
        example: { type: "string", description: "One natural English example relevant to the learner's topic, marked as an example rather than a quote." },
      },
      required: ["phrase", "meaning", "example"],
    },
    practice: { type: "string", description: "One short Japanese-only situational prompt for a NEW sentence. Do not quote or name the English collocation or its answer." },
  },
};

export const ASSESSMENT_SCHEMA = {
  type: "array",
  maxItems: 4,
  items: {
    type: "object",
    properties: {
      criterion: { type: "string", enum: CRITERIA },
      score: { type: ["integer", "null"], minimum: 1, maximum: 5 },
      evidence: { type: "string", description: "Exact short quote from THIS telling's transcript supporting the score. Empty if not assessable." },
      reason: { type: "string", description: "Japanese: specific strength or limitation in this quote, and how to improve. No generic praise." },
    },
    required: ["criterion", "score", "evidence", "reason"],
  },
};
