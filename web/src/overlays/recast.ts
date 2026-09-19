/**
 * recast ウィジェット。学習者の文と、表現を使った言い直しを並べる。
 * 先生が言い直しを声で言うのと同時に出る。文字は textContent だけ。
 *
 * 案D(docs/mockups/live-d-hybrid.html)から: 消えた語に線、増えた語に色を付け、
 * 読んで終わらせずに「もう一度言う」まで連れていく。カードは自分では消えない。
 * 「もう一度言う」か「あとで」で閉じ、レール(rail.ts)へ移る。操作の手(actions)を
 * 渡さなければ操作列は出ない(指導ノートや履歴で使う形)。
 */
import type { RecastProps } from "../../../shared/messages";
import { wordDiff, type DiffToken } from "../../../shared/wordDiff";
import { renderTeaching } from "./teaching";

export interface RecastActions {
  /** 「もう一度言う」。カードを閉じ、次の発話を言い直しの挑戦として聞く。 */
  onSayAgain: () => void;
  /** 「あとで」。カードを閉じ、レールに残す。 */
  onLater: () => void;
}

/** 差分の語を並べる。同じ語はそのまま、消えた語は <s>、増えた語は <mark>。続く同じ印は1つにまとめる。 */
export function renderDiffLine(tokens: DiffToken[], className: string): HTMLElement {
  const line = document.createElement("p");
  line.className = className;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (i > 0) line.appendChild(document.createTextNode(" "));
    if (token.op === "same") {
      line.appendChild(document.createTextNode(token.text));
      i++;
      continue;
    }
    const run: string[] = [];
    while (i < tokens.length && tokens[i]!.op === token.op) run.push(tokens[i++]!.text);
    const node = document.createElement(token.op === "removed" ? "s" : "mark");
    node.textContent = run.join(" ");
    line.appendChild(node);
  }
  return line;
}

export function renderRecast(props: RecastProps, actions?: RecastActions): HTMLElement {
  const card = document.createElement("div");
  card.className = "card recast";
  card.dataset.kind = props.kind ?? "correction";

  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = props.kind === "upgrade" ? "正しい文に、もう一つの言い方" : "言い直してみよう";
  card.appendChild(kicker);

  const diff = wordDiff(props.original, props.better);
  card.appendChild(renderDiffLine(diff.original, "orig"));

  const arrow = document.createElement("div");
  arrow.className = "arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↓";
  card.appendChild(arrow);

  card.appendChild(renderDiffLine(diff.better, "better"));

  if (props.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = props.note;
    card.appendChild(note);
  }
  const teaching = renderTeaching(props.teaching);
  if (teaching) card.appendChild(teaching);

  if (actions) {
    const row = document.createElement("div");
    row.className = "actions";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "primary";
    again.textContent = "もう一度言う";
    again.addEventListener("click", actions.onSayAgain);
    const later = document.createElement("button");
    later.type = "button";
    later.className = "later";
    later.textContent = "あとで";
    later.addEventListener("click", actions.onLater);
    row.append(again, later);
    card.appendChild(row);
  }
  return card;
}
