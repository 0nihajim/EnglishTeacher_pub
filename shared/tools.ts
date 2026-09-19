/**
 * ツール登録簿 — モデルが画面に出せるもの、こちらに報告できるもの。
 *
 * ここが元のデモといちばん違う。デモではライブ音声モデルがツールを1つも持たず、
 * 画面に何か出したいときは裏の Responses モデルにターンを丸ごと渡していた
 * (server/src/gptlive.ts の委譲機構)。Gemini Live はライブモデル自身が
 * function calling を持つので、その委譲段は消えている。
 *
 * ここは全モードぶんの登録簿。どのモードでどれを宣言するかは
 * server/src/modes/index.ts が選ぶ(瞬間英作文にカードのツールは要らない)。
 *
 * ツールを足す手順:
 *   1. ここに定義(スキーマ + 引数の型)を書く。
 *   2. 画面に出すだけなら server/src/tools.ts でウィジェットに対応づける。
 *      進行に関わるならコーチ(server/src/modes/*.ts)の onToolCall で受ける。
 *   3. 新しいウィジェットが要るなら shared/messages.ts に型を足し、
 *      web/src/overlays/ に描画を足す。既存を使い回すなら3は不要。
 *
 * パラメータは全部 string にしてある。ライブモデルは音声の合間に引数を組むので、
 * 入れ子や配列を要求すると失敗が増える。
 */

/** function response に付ける再生制御。Gemini の FunctionResponseScheduling に対応。 */
export type Scheduling = "SILENT" | "WHEN_IDLE" | "INTERRUPT";

export interface ToolDef {
  name: string;
  description: string;
  /** パラメータ名 → 説明。型は全部 string。 */
  parameters: Record<string, string>;
  required: string[];
  /**
   * 結果を受け取ったモデルの振る舞い。
   * SILENT    = 何も言わずに知っておく(カード表示はこれ。喋りを邪魔しない)
   * WHEN_IDLE = いま話していることを終えてから触れる
   * INTERRUPT = 中断して即座に結果を伝える
   */
  scheduling: Scheduling;
}

const TEACHING_PARAMETERS = {
  alternative: "One other natural English sentence with the same intended meaning. Optional, but pair with alternative_note.",
  alternative_note: "Japanese: when to choose the alternative (tone, emphasis, or situation). Do not call the original wrong if it is correct.",
  collocation: "One useful common collocation or construction from this topic, including its preposition, e.g. make progress on + noun.",
  collocation_note: "Japanese meaning and usage of the collocation.",
  collocation_example: "One new English example of the collocation in the learner's context. This is an example, not a quote.",
  practice: "One short Japanese-only prompt for a NEW sentence. Describe a situation without quoting or naming the English expression or its answer. Optional.",
};

export const TOOLS: readonly ToolDef[] = [
  {
    name: "review_result",
    description: "Personal review only. Judge the submitted attempt for the current attempt_id. Never reveal the answer; the app controls hints, model reveal and retry. Stop speaking after reporting.",
    parameters: {
      attempt_id: "Copy exactly the attempt_id in the latest app instruction.",
      verdict: "correct, close, wrong, or uncertain (audio insufficient to judge). Accept natural alternatives.",
      said: "What the learner actually said.",
      note: "Specific Japanese explanation of the verdict. Shown only after model reveal or completion.",
      question: "One Japanese-only question to help the learner notice and fix the problem. No English words or corrected answer.",
    },
    required: ["attempt_id", "verdict"],
    scheduling: "SILENT",
  },
  {
    name: "show_term_card",
    description:
      "Put a card on the learner's screen showing an English word or phrase, how to pronounce it, " +
      "and what it means in Japanese. This is the default way to reinforce anything you teach out " +
      "loud. The card appears beside your speech; it does not interrupt you.",
    parameters: {
      term:
        "The English word or phrase itself, exactly as the learner should say it: " +
        "'Nice to meet you.', 'Could you say that again?'",
      reading:
        "How it sounds, written in katakana so a Japanese speaker can read it aloud, " +
        "chunked with ・ at natural breaks: 'クッジュー・セイ・ザッ・アゲン'. Optional.",
      meaning: "What it means, in Japanese: 「もう一度言ってもらえますか」. Optional.",
      example:
        "One short line showing when to use it, in English: " +
        "'Sorry, could you say that again? It was a bit fast.' Optional.",
    },
    required: ["term"],
    // 表示だけが目的。「カードを出しますね」と言い出さないよう黙って受け取らせる。
    scheduling: "SILENT",
  },
  {
    name: "show_progress",
    description:
      "Scene practice only. Put today's target expressions on the learner's screen with how they did " +
      "with each one so far. The panel takes the whole stage while it is up. The app keeps the " +
      "checklist — you supply only the heading, and the tool result hands back the current status of " +
      "each target, so walk through THOSE out loud. Call this when the learner asks how they are " +
      "doing, or when you are wrapping the scene up. Never call it in answer to a request for a new " +
      "phrase.",
    parameters: {
      title: "Heading for the panel, in Japanese: 「ここまでの表現」「今日の結果」",
    },
    required: ["title"],
    // 一覧を読み上げてほしいが、話している途中を切らせたくはない。
    scheduling: "WHEN_IDLE",
  },
  {
    name: "hide_card",
    description:
      "Clear whatever card is on the learner's screen. Cards clear themselves when their time is " +
      "up, so only call this to take one down early.",
    parameters: {
      reason: "Why it is being cleared, one short phrase.",
    },
    required: ["reason"],
    scheduling: "SILENT",
  },
  {
    name: "show_recast",
    description:
      "Put the learner's sentence on screen next to a correction or optional " +
      "natural alternative, including useful language beyond today's targets. Call it every time you rephrase what the learner just said, " +
      "while you say the better version aloud — they read it as they hear it.",
    parameters: {
      original: "What the learner actually said, as closely as you heard it: 'I do the login bug now.'",
      better: "The natural version preserving the learner's intended meaning: \"I'm working on the login bug.\"",
      kind: "correction for an actual error; upgrade for an optional alternative to already correct English.",
      note: "Japanese: what changed and WHY it fits this context, not just 'more natural'.",
      ...TEACHING_PARAMETERS,
    },
    required: ["original", "better"],
    // 言い直しは声で言う。カードは添えるだけ。
    scheduling: "SILENT",
  },
  {
    name: "report_target",
    description:
      "Scene practice only. Record how the learner did with one of today's target expressions. Call " +
      "it right after they use one — well or with a mistake — or right after you had to say it for " +
      "them. The app keeps the checklist; you only report.",
    parameters: {
      term: "The target expression exactly as it appears in today's list.",
      outcome: "One of: used_well, used_with_error, modeled (you had to say it for them).",
      note: "One short remark in Japanese on the mistake, if there was one. Optional.",
    },
    required: ["term", "outcome"],
    scheduling: "SILENT",
  },
  {
    name: "drill_result",
    description:
      "Instant-translation drill only. Report your verdict on the learner's English for the current " +
      "prompt, right after you have heard their attempt or decided they are stuck. The app records it " +
      "and shows the model answer; when your feedback is done and you stop talking, the app hands you " +
      "the next prompt.",
    parameters: {
      verdict:
        "One of: correct (same meaning, natural English), close (meaning right, one small slip), " +
        "wrong, skipped (no usable attempt).",
      said: "What the learner said, as closely as you heard it. Optional.",
      note: "Japanese: specific reason for the verdict, tied to the learner's words. Credit valid alternative answers.",
      ...TEACHING_PARAMETERS,
    },
    required: ["verdict"],
    // 判定はもう声で言っている。結果を返しても喋らせない。
    scheduling: "SILENT",
  },
];

/** 名前からツール定義を引く。未知の名前は undefined。 */
export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((def) => def.name === name);
}
