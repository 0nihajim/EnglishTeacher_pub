/**
 * summary ウィジェット。シーン会話の途中経過と瞬間英作文の結果で、どちらも舞台を
 * まるごと使う。行の中身(見出し・ラベル・値・色)はサーバーが決める。
 */
import type { SummaryProps } from "../../../shared/messages";

/** 出しておく時間。先生が読み上げて締めるのに足りる長さ。 */
export const SUMMARY_MS = 25_000;

export function renderSummary(props: SummaryProps): HTMLElement {
  const card = document.createElement("div");
  card.className = "card summary";

  const heading = document.createElement("h3");
  heading.textContent = props.title;
  card.appendChild(heading);

  const list = document.createElement("ul");
  for (const line of props.lines) {
    const row = document.createElement("li");

    const label = document.createElement("span");
    label.className = "t";
    label.textContent = line.label;
    row.appendChild(label);

    const value = document.createElement("span");
    value.className = `v ${line.tone ?? ""}`.trim();
    value.textContent = line.value;
    row.appendChild(value);

    list.appendChild(row);
  }
  card.appendChild(list);

  if (props.footer) {
    const footer = document.createElement("div");
    footer.className = "footer";
    footer.textContent = props.footer;
    card.appendChild(footer);
  }
  return card;
}
