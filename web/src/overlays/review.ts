import type { ControlAction, ReviewOutcome, ReviewPhase, ReviewStepProps } from "../../../shared/messages";
import { renderTeaching } from "./teaching";

const TITLES: Record<ReviewPhase, string> = {
  recall: "まず、自分の言葉で。", repair: "自分で直してみよう。", hint: "少しだけ、手がかり。",
  model: "お手本を確認。", retry: "見ないで、もう一度。", done: "今回の振り返り",
};
const OUTCOMES: Record<ReviewOutcome, string> = {
  independent: "自力で言えた", repaired: "自分で直せた", hinted: "ヒントで言えた",
  modeled: "お手本の後に言えた", again: "もう一度練習", skipped: "今回はスキップ",
};
const text = (tag: string, className: string, value: string) => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
};

export function renderReviewStep(props: ReviewStepProps, control?: (action: ControlAction) => void): HTMLElement {
  const card = text("div", "card retrieval", "");
  card.dataset.phase = props.phase;
  card.append(text("div", "retrieval-counter", `今日の復習 ${props.index} / ${props.total}`));
  card.append(text("h3", "", props.outcome ? OUTCOMES[props.outcome] : TITLES[props.phase]));
  card.append(text("p", "retrieval-cue", props.cue));
  if (props.original) card.append(text("blockquote", "retrieval-original", `前回: ${props.original}`));
  if (props.hint) card.append(text("p", "retrieval-hint", props.hint));
  // サーバーの契約に加え、描画側でも段階を確認して答えを隠す。
  if (props.phase === "model" || props.phase === "done") {
    if (props.answer) card.append(text("p", "retrieval-answer", props.answer));
    if (props.said) card.append(text("p", "teaching-note", `あなた: ${props.said}`));
    if (props.note) card.append(text("p", "teaching-note", props.note));
    if (props.phase === "model" && props.teaching?.collocation?.example) {
      card.append(text("p", "teaching-example", props.teaching.collocation.example));
    }
    if (props.phase === "done") {
      const teaching = renderTeaching(props.teaching);
      if (teaching) card.append(teaching);
      card.append(text("p", "retrieval-next", props.outcome === "independent"
        ? "次の復習まで、少し間隔を空けます。"
        : props.outcome === "again" || props.outcome === "skipped" ? "10分後から、もう一度練習できます。" : "明日、もう一度思い出してみよう。"));
    }
  } else {
    card.append(text("p", "teaching-note", "「話す」で開始し、言い終えたら「送信」。"));
  }
  if (!control) return card;
  const actions = text("div", "retrieval-actions", "");
  const add = (label: string, action: ControlAction, primary = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("click", () => control(action));
    actions.append(button);
  };
  if (props.phase === "model") add("隠して、もう一度話す", "retry", true);
  else if (props.phase === "done") add(props.index === props.total ? "今日の結果を見る" : "次の課題へ", "next", true);
  else {
    if (props.phase !== "hint") add("ヒント", "hint");
    add("お手本を見る", "reveal");
  }
  if (props.phase !== "done") add("スキップ", "skip");
  card.append(actions);
  return card;
}
