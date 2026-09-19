import type { DailyReviewPlan } from "../../shared/messages";

export function createDailyReview(host: HTMLElement, start: () => void) {
  const status = host.querySelector(".daily-status") as HTMLElement;
  const list = host.querySelector(".daily-items") as HTMLElement;
  const button = host.querySelector("button") as HTMLButtonElement;
  let plan: DailyReviewPlan | null = null;
  let busy = false;
  let failed = false;
  let request = 0;
  let refreshTimer: number | undefined;
  const render = () => {
    window.clearTimeout(refreshTimer);
    if (plan?.nextDueAt) {
      const delay = new Date(plan.nextDueAt).getTime() - Date.now();
      refreshTimer = window.setTimeout(() => void refresh(), Math.max(1000, Math.min(delay, 86_400_000)));
    }
    list.replaceChildren();
    button.disabled = busy || (!failed && !plan?.items.length);
    button.textContent = failed ? "読み込み直す" : "復習をはじめる ↗";
    if (!plan) {
      status.textContent = failed ? "復習を読み込めませんでした" : "復習を読み込み中…";
      return;
    }
    if (plan.items.length) {
      status.textContent = `${plan.items.length}課題 · 約${plan.estimatedMinutes}分${plan.due > plan.items.length ? ` · 復習待ち ${plan.due}件` : ""}`;
      for (const item of plan.items) {
        const li = document.createElement("li");
        const title = document.createElement("span");
        title.textContent = item.kind === "repair" ? "前回の文を言い直す" : item.cue;
        const source = document.createElement("small");
        source.textContent = item.source;
        li.append(title, source);
        list.appendChild(li);
      }
    } else if (plan.total) {
      const next = plan.nextDueAt ? new Date(plan.nextDueAt).toLocaleString("ja-JP", {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      }) : "";
      status.textContent = `${plan.practicedToday ? `今日${plan.practicedToday}課題を練習済み。` : "いま復習する課題はありません。"}${next ? ` 次回 ${next}` : ""}`;
    } else {
      status.textContent = "会話で練習した表現が、ここに集まります。";
    }
  };
  async function refresh() {
    const current = ++request;
    try {
      const response = await fetch("/api/review/today", { cache: "no-store" });
      if (!response.ok) throw new Error("review unavailable");
      const data = await response.json() as DailyReviewPlan;
      if (!Array.isArray(data.items)) throw new Error("invalid plan");
      if (current !== request) return;
      plan = data;
      failed = false;
    } catch {
      if (current !== request) return;
      plan = null;
      failed = true;
    }
    render();
  }
  button.addEventListener("click", () => {
    if (failed) void refresh();
    else if (plan?.items.length && !busy) start();
  });
  render();
  return {
    refresh,
    setBusy(value: boolean) { busy = value; button.disabled = value || (!failed && !plan?.items.length); },
  };
}
