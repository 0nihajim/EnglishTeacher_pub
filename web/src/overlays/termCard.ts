/**
 * term_card ウィジェット。教わった表現1つを画面下に出す。
 * 文字は textContent だけで入れる — 値はモデルから来るので、markup にしない。
 */
import type { TermCardProps } from "../../../shared/messages";

/** 出しておく時間。声で言い切って、学習者が読み返す余裕まで。 */
export const TERM_CARD_MS = 7_000;

export function renderTermCard(props: TermCardProps): HTMLElement {
  const card = document.createElement("div");
  card.className = "card term";

  const term = document.createElement("div");
  term.className = "term-line";
  term.textContent = props.term;
  card.appendChild(term);

  if (props.reading) {
    const reading = document.createElement("div");
    reading.className = "reading";
    reading.textContent = props.reading;
    card.appendChild(reading);
  }
  if (props.meaning) {
    const meaning = document.createElement("div");
    meaning.className = "meaning";
    meaning.textContent = props.meaning;
    card.appendChild(meaning);
  }
  if (props.example) {
    const example = document.createElement("div");
    example.className = "example";
    example.textContent = props.example;
    card.appendChild(example);
  }
  return card;
}
