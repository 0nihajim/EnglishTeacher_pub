/**
 * 話し直しトレーニングの「整理役」。会話は Live が持ち、説明の整理と振り返りだけを
 * 通常のマルチモーダルモデル(Gemini Flash)に頼む。
 *
 * 渡すもの: 学習者の画像、その回の録音(WAV)、字幕の文字起こし(参考)。
 * 返るもの: 構造化出力(JSON)。1回目は「伝わった要点・改善点1〜2個・2回目のための
 * キーワード・追加の質問」、2回目は「要点・使えた言い方・一言」。
 *
 * Live に頼まない理由: 講評の中身をカードに出すには正確な文が要り、音声モデルの
 * ツール引数より、音声を聞き直して JSON で返す通常モデルのほうが確実。文字起こしでは
 * なく録音を渡すのは、初級者の英語は字幕が崩れやすく、詰まりや日本語の混じり方まで
 * 聞かせたいから(1分 ≈ 1,920 トークン)。
 *
 * 値はモデルから来るので、parse* で長さと数を切り、欠けは埋める。
 */

import { GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import type { AssessmentItem, RetellImprovement, TeachingNotes } from "../../shared/messages";
import { ASSESSMENT_SCHEMA, TEACHING_SCHEMA, parseAssessment, parseTeachingNotes } from "./feedback";
import { config } from "./config";
import type { LearnerImage } from "./image";
import { DEFAULT_RETELL_QUESTION, retellComparePrompt, tellingAnalysisPrompt } from "./prompts";
import { wavFromPcm16, type Take } from "./takes";

/** 1回目の整理。 */
export interface TellingAnalysis {
  /** 学習者が実際に言ったこと(言い直しや相槌を除いた程度)。 */
  transcript: string;
  /** 伝わった要点。日本語の短い札。 */
  points: string[];
  improvements: RetellImprovement[];
  /** 2回目のためのキーワード。英語の短い手がかり、話の順。 */
  keywords: string[];
  /** 追加の質問。英語。 */
  question: string;
  assessment?: AssessmentItem[];
  teaching?: TeachingNotes;
}

/** 2回目の振り返り。 */
export interface RetellAnalysis {
  transcript: string;
  points: string[];
  /** 改善点の自然な言い方のうち、2回目で使えたもの(一覧の文をそのまま)。 */
  used: string[];
  /** 一言。良くなった点と、続けて直す点。日本語。 */
  comment: string;
  assessment?: AssessmentItem[];
}

export interface TellingInput {
  image: LearnerImage;
  take: Take;
  /** 字幕(Live の文字起こし)。参考として渡す。 */
  transcriptHint: string;
  /** 板に出した観点。 */
  prompts: readonly string[];
}

export interface RetellInput {
  image: LearnerImage;
  take: Take;
  transcriptHint: string;
  first: TellingAnalysis;
}

/** コーチが見る面。実物は GeminiAnalyst、テストは偽物。 */
export interface Analyst {
  analyzeTelling(input: TellingInput): Promise<TellingAnalysis>;
  analyzeRetell(input: RetellInput): Promise<RetellAnalysis>;
}

export class AnalysisError extends Error {}

/** 1回の呼び出しの上限。これを超えたら Live の先生が自分で講評する(コーチの fallback)。 */
export const FLASH_TIMEOUT_MS = 25_000;

// ── スキーマ(responseJsonSchema) ─────────────────────────────────────────────

const STRING_LIST = (description: string, maxItems: number) => ({
  type: "array",
  description,
  items: { type: "string" },
  maxItems,
});

export const TELLING_SCHEMA = {
  type: "object",
  properties: {
    transcript: {
      type: "string",
      description: "What the learner actually said, cleaned only of false starts. Japanese words stay in Japanese.",
    },
    points: STRING_LIST("Points the learner conveyed, as short Japanese labels (2-5).", 5),
    improvements: {
      type: "array",
      description: "Up to two priority corrections that most help the story hold together. Empty if no correction is needed.",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          original: { type: "string", description: "What the learner said, or reached for, in their words." },
          better: {
            type: "string",
            description: "The natural version, keeping their meaning and vocabulary level.",
          },
          note: { type: "string", description: "One short Japanese pointer on what changed." },
        },
        required: ["original", "better", "note"],
      },
    },
    keywords: STRING_LIST("Short English cues for the second telling, in story order (3-6, 1-3 words each).", 6),
    question: { type: "string", description: "One follow-up question in English about this picture and story." },
    assessment: ASSESSMENT_SCHEMA,
    teaching: TEACHING_SCHEMA,
  },
  required: ["transcript", "points", "improvements", "keywords", "question", "assessment", "teaching"],
} as const;

export const RETELL_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "What the learner said this time, cleaned only of false starts." },
    points: STRING_LIST("Points conveyed this time, as short Japanese labels.", 5),
    used: STRING_LIST("Offered natural versions whose correction the learner used correctly in context, copied exactly. Attempts alone do not count.", 2),
    comment: {
      type: "string",
      description: "One line in Japanese: what got better, and one thing to keep working on.",
    },
    assessment: ASSESSMENT_SCHEMA,
  },
  required: ["transcript", "points", "used", "comment", "assessment"],
} as const;

// ── 応答の整形 ────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function strList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v, maxLen))
    .filter((v) => v !== "")
    .slice(0, maxItems);
}

/** Flash の JSON を TellingAnalysis に。壊れた項目は落とし、欠けは埋める。 */
export function parseTellingAnalysis(raw: unknown): TellingAnalysis {
  if (!isRecord(raw)) throw new AnalysisError("分析の応答がオブジェクトではない");
  const improvements: RetellImprovement[] = [];
  if (Array.isArray(raw.improvements)) {
    for (const item of raw.improvements) {
      if (!isRecord(item)) continue;
      const original = str(item.original, 200);
      const better = str(item.better, 200);
      if (!original || !better) continue;
      const imp: RetellImprovement = { original, better };
      const note = str(item.note, 160);
      if (note) imp.note = note;
      improvements.push(imp);
      if (improvements.length === 2) break;
    }
  }
  const result: TellingAnalysis = {
    transcript: str(raw.transcript, 2_000),
    points: strList(raw.points, 5, 40),
    improvements,
    keywords: strList(raw.keywords, 6, 40),
    question: str(raw.question, 200) || DEFAULT_RETELL_QUESTION,
  };
  const assessment = parseAssessment(raw.assessment, result.transcript);
  const teaching = parseTeachingNotes(raw.teaching);
  if (assessment) result.assessment = assessment;
  if (teaching) result.teaching = teaching;
  return result;
}

export function parseRetellAnalysis(raw: unknown): RetellAnalysis {
  if (!isRecord(raw)) throw new AnalysisError("振り返りの応答がオブジェクトではない");
  const result: RetellAnalysis = {
    transcript: str(raw.transcript, 2_000),
    points: strList(raw.points, 5, 40),
    used: strList(raw.used, 2, 200),
    comment: str(raw.comment, 200),
  };
  const assessment = parseAssessment(raw.assessment, result.transcript);
  if (assessment) result.assessment = assessment;
  return result;
}

// ── Gemini ───────────────────────────────────────────────────────────────────

export class GeminiAnalyst implements Analyst {
  private readonly ai: GoogleGenAI;

  constructor(
    private readonly model: string = config.gemini.flashModel,
    ai?: GoogleGenAI,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.ai = ai ?? new GoogleGenAI({ apiKey: config.gemini.apiKey });
  }

  async analyzeTelling(input: TellingInput): Promise<TellingAnalysis> {
    const raw = await this.generate(
      [...mediaParts(input.image, input.take), { text: tellingAnalysisPrompt(input.prompts, input.transcriptHint) }],
      TELLING_SCHEMA,
    );
    return parseTellingAnalysis(raw);
  }

  async analyzeRetell(input: RetellInput): Promise<RetellAnalysis> {
    const raw = await this.generate(
      [...mediaParts(input.image, input.take), { text: retellComparePrompt(input.first, input.transcriptHint) }],
      RETELL_SCHEMA,
    );
    return parseRetellAnalysis(raw);
  }

  /**
   * 構造化出力で1回呼ぶ。思考は浅くして待ち時間を抑える。thinkingLevel をモデルが
   * 受け付けなかった(400)ときだけ、外して一度やり直す。
   */
  private async generate(parts: Part[], schema: object): Promise<unknown> {
    const startedAt = Date.now();
    let text: string | undefined;
    try {
      text = await this.call(parts, schema, true);
    } catch (err) {
      if (!isInvalidArgument(err)) throw err;
      this.log(`Flash が設定を拒否 — thinkingLevel を外してやり直す: ${describe(err)}`);
      text = await this.call(parts, schema, false);
    }
    this.log(`Flash 応答 ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${text?.length ?? 0} 文字`);
    if (!text) throw new AnalysisError("Flash が空の応答を返した");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AnalysisError(`Flash の応答が JSON ではない: ${text.slice(0, 80)}`);
    }
  }

  private async call(parts: Part[], schema: object, withThinking: boolean): Promise<string | undefined> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        temperature: 0.4,
        httpOptions: { timeout: FLASH_TIMEOUT_MS },
        ...(withThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
      },
    });
    return response.text;
  }
}

/** 画像と録音(WAV)。テキストより前に置く。 */
function mediaParts(image: LearnerImage, take: Take): Part[] {
  return [
    { inlineData: { mimeType: image.mimeType, data: image.data } },
    { inlineData: { mimeType: "audio/wav", data: wavFromPcm16(take.pcm).toString("base64") } },
  ];
}

function isInvalidArgument(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 400) return true;
  const message = describe(err);
  return /\b400\b|INVALID_ARGUMENT/i.test(message);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
