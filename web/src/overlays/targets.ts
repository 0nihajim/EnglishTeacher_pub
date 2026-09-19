/**
 * targets ウィジェット。シーン会話で、今日の表現と状態を舞台の上の帯に出し続ける。
 * サーバーが状態を持ち、変わるたびに全部を送り直す。ここは描くだけ。
 *
 * 案Dから: 会話中は英語だけを見せる。日本語の意味はチップを押したときに1つだけ出す。
 * 読む量を増やすと口が止まるので、帯は「使えたら点灯する」以上のことをしない。
 */
import type { TargetStatusKind, TargetsProps } from "../../../shared/messages";

const LABEL: Record<TargetStatusKind, string> = {
  unused: "まだ",
  modeled: "先生が示した",
  heard: "口にした",
  used_with_error: "使えた(要修正)",
  used_well: "使えた",
};

export function renderTargets(props: TargetsProps): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "targets";
  strip.setAttribute("role", "list");
  strip.setAttribute("aria-label", `${props.title} — 今日の表現`);

  const closeAll = () => {
    for (const chip of strip.querySelectorAll<HTMLButtonElement>(".chip[aria-expanded='true']")) {
      chip.setAttribute("aria-expanded", "false");
    }
  };

  for (const target of props.targets) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.status = target.status;
    chip.setAttribute("role", "listitem");
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-label", `${target.term} — ${LABEL[target.status]}`);

    const term = document.createElement("span");
    term.className = "t";
    term.textContent = target.term;
    chip.appendChild(term);

    const meaning = document.createElement("span");
    meaning.className = "m";
    meaning.textContent = target.meaning;
    chip.appendChild(meaning);

    chip.addEventListener("click", () => {
      const open = chip.getAttribute("aria-expanded") === "true";
      closeAll();
      if (!open) chip.setAttribute("aria-expanded", "true");
    });
    strip.appendChild(chip);
  }

  const used = props.targets.filter((t) => t.status === "used_well").length;
  const count = document.createElement("span");
  count.className = "targets-count";
  count.textContent = `${used} / ${props.targets.length}`;
  count.setAttribute("aria-label", `使えた表現 ${used} / ${props.targets.length}`);
  strip.appendChild(count);
  return strip;
}
