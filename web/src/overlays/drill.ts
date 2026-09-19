/**
 * 瞬間英作文の2枚: 出題(drill_prompt)と判定(drill_answer)。
 * 出題のカードは残り時間のバーを持つ。長さはサーバーが決めた制限時間。
 * 文字は textContent だけ。
 */
import type { DrillAnswerProps, DrillPromptProps, DrillVerdict } from "../../../shared/messages";
import { renderTeaching } from "./teaching";

/** 判定のカードを出しておく時間。先生の講評と復唱のあいだ。 */
export const DRILL_ANSWER_MS = 12_000;

/**
 * 出題のカードは、判定のカードに置き換わるまで居るのが基本。ここは保険で、
 * 制限時間 + ヒント + 諦めの分まで持たせる。
 */
export function drillPromptHoldMs(props: DrillPromptProps): number {
  return props.limitMs + 40_000;
}

const VERDICT_LABEL: Record<DrillVerdict, string> = {
  correct: "正解",
  close: "惜しい",
  wrong: "不正解",
  skipped: "スキップ",
};

export function renderDrillPrompt(props: DrillPromptProps): HTMLElement {
  const card = document.createElement("div");
  card.className = "card drill";

  const counter = document.createElement("div");
  counter.className = "counter";
  counter.textContent = `${props.index} / ${props.total}`;
  card.appendChild(counter);

  const ja = document.createElement("div");
  ja.className = "ja";
  ja.textContent = props.ja;
  card.appendChild(ja);

  const cue = document.createElement("div");
  cue.className = "cue";
  cue.textContent = "英語で言ってみましょう";
  card.appendChild(cue);

  const timer = document.createElement("div");
  timer.className = "timer";
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.animationDuration = `${props.limitMs}ms`;
  timer.appendChild(bar);
  card.appendChild(timer);

  return card;
}

export function renderDrillAnswer(props: DrillAnswerProps): HTMLElement {
  const card = document.createElement("div");
  card.className = "card answer";
  card.dataset.verdict = props.verdict;

  const head = document.createElement("div");
  head.className = "head";
  const verdict = document.createElement("span");
  verdict.className = "verdict";
  verdict.textContent = VERDICT_LABEL[props.verdict];
  const ja = document.createElement("span");
  ja.className = "ja";
  ja.textContent = props.ja;
  head.append(verdict, ja);
  card.appendChild(head);

  const answer = document.createElement("div");
  answer.className = "answer-line";
  answer.textContent = props.answer;
  card.appendChild(answer);

  if (props.said) {
    const said = document.createElement("div");
    said.className = "said";
    said.textContent = `あなた: ${props.said}`;
    card.appendChild(said);
  }
  if (props.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = props.note;
    card.appendChild(note);
  }
  if (props.latencyMs !== undefined) {
    const latency = document.createElement("div");
    latency.className = "latency";
    latency.textContent = `反応 ${(props.latencyMs / 1000).toFixed(1)} 秒`;
    card.appendChild(latency);
  }
  const teaching = renderTeaching(props.teaching);
  if (teaching) card.appendChild(teaching);
  return card;
}
