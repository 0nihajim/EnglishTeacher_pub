import type { AssessmentCriterion, AssessmentItem, TeachingNotes } from "../../../shared/messages";

function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

export function renderTeaching(notes: TeachingNotes | undefined): HTMLElement | null {
  if (!notes || (!notes.alternative && !notes.collocation && !notes.practice)) return null;
  const details = document.createElement("details");
  details.className = "teaching";
  details.appendChild(text("summary", "", "別の言い方・表現の練習"));
  if (notes.alternative) {
    const section = document.createElement("section");
    section.append(
      text("h4", "teaching-label", "別の自然な言い方"),
      text("p", "teaching-phrase", notes.alternative.phrase),
      text("p", "teaching-note", notes.alternative.usage),
    );
    details.appendChild(section);
  }
  if (notes.collocation) {
    const section = document.createElement("section");
    section.append(
      text("h4", "teaching-label", "コロケーション"),
      text("p", "teaching-phrase", notes.collocation.phrase),
      text("p", "teaching-note", notes.collocation.meaning),
      text("p", "teaching-example", notes.collocation.example),
    );
    details.appendChild(section);
  }
  if (notes.practice) {
    const section = document.createElement("section");
    section.append(text("h4", "teaching-label", "自分の文で練習"), text("p", "teaching-note", notes.practice));
    details.appendChild(section);
  }
  return details;
}

const LABELS: Record<AssessmentCriterion, string> = {
  meaning: "伝わりやすさ",
  grammar: "文法",
  naturalness: "自然さ",
  range: "表現の幅",
};

export function renderAssessment(items: readonly AssessmentItem[] | undefined): HTMLElement | null {
  if (!items?.length) return null;
  const section = document.createElement("section");
  section.className = "assessment";
  section.appendChild(text("h4", "teaching-label", "今回の発話の評価"));
  const list = document.createElement("div");
  list.className = "assessment-items";
  for (const item of items) {
    const details = document.createElement("details");
    details.className = "assessment-item";
    const summary = document.createElement("summary");
    summary.append(text("span", "", LABELS[item.criterion]), text("span", "assessment-score", item.score === null ? "保留" : `${item.score} / 5`));
    details.appendChild(summary);
    if (item.evidence) details.appendChild(text("blockquote", "", item.evidence));
    details.appendChild(text("p", "teaching-note", item.reason));
    list.appendChild(details);
  }
  const rubric = document.createElement("details");
  rubric.className = "assessment-rubric";
  rubric.append(
    text("summary", "", "採点の目安"),
    text("p", "teaching-note", "5：この課題で一貫して適切、4：ほぼ適切、3：伝わるが改善の余地あり、2：聞き手の補完が必要、1：大きな困難あり。根拠不足は保留。今回の発話に対するAIの評価で、発音や資格試験のスコアではありません。"),
  );
  section.append(list, rubric);
  return section;
}
