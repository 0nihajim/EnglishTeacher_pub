import type { UiMessage } from "../../shared/messages";
import { renderDrillAnswer } from "./overlays/drill";
import { renderRecast } from "./overlays/recast";
import { renderRetellCompare, renderRetellReview } from "./overlays/retell";
import { renderReviewStep } from "./overlays/review";

/** 会話を止めずに読める指導ノート。終了後も残し、次の接続成功時に入れ替える。 */
export function createFeedbackNotebook(host: HTMLDetailsElement, maxEntries = 30) {
  const list = host.querySelector(".feedback-list") as HTMLElement;
  const count = host.querySelector(".feedback-count") as HTMLElement;
  const entries = new Map<string, HTMLElement>();

  return {
    clear() {
      entries.clear();
      list.replaceChildren();
      count.textContent = "0";
      host.hidden = true;
      host.open = false;
    },
    render(message: UiMessage) {
      const key = JSON.stringify(message);
      if (entries.has(key)) return;
      let card: HTMLElement;
      switch (message.widget) {
        case "review_step":
          if (message.props.phase !== "done") return;
          card = renderReviewStep(message.props);
          break;
        case "recast": card = renderRecast(message.props); break;
        case "drill_answer": card = renderDrillAnswer(message.props); break;
        case "retell_review": card = renderRetellReview(message.props); break;
        case "retell_compare": card = renderRetellCompare(message.props, null); break;
        default: return;
      }
      for (const details of card.querySelectorAll<HTMLDetailsElement>(".teaching")) details.open = true;
      entries.set(key, card);
      list.prepend(card);
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.get(oldest)?.remove();
          entries.delete(oldest);
        }
      }
      count.textContent = String(entries.size);
      host.hidden = false;
    },
  };
}
