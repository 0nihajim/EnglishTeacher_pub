/**
 * 言い直しレール(案D)。舞台の右に、このセッションの言い直しを積む。
 *
 * 舞台のカードは1枚ずつしか出ないので、閉じた言い直しはここに残す。札は4つ:
 *  onstage  いま舞台に出ている(ここでは薄く1行だけ)
 *  pending  まだ言えていない。「言ってみる」で再挑戦できる
 *  awaiting 「もう一度言う」を押した直後。次の発話を挑戦として聞く
 *  done     言えた(文字起こしの照合。目標表現の heard と同じ強さの根拠)
 *
 * 目標表現は載せない。舞台の帯(targets)に任せ、レールは言い直しだけにする。
 * 右の欄が読み物になると、会話中に読む時間が増えるため。
 */
import type { RecastProps } from "../../shared/messages";
import { saidBetter, wordDiff, type WordDiff } from "../../shared/wordDiff";
import { renderDiffLine } from "./overlays/recast";

export type RailStatus = "onstage" | "pending" | "awaiting" | "done";

interface RailItem {
  key: string;
  props: RecastProps;
  diff: WordDiff;
  status: RailStatus;
  /** 直前の挑戦で言えなかった(pending に戻った)。 */
  missed: boolean;
  /** ボタンを押さずに話し始めた挑戦。外れても「もう一度」とは言わない。 */
  implicit: boolean;
  doneAtMs?: number;
}

export interface Rail {
  /** 新しい言い直しが舞台に出た。 */
  stage: (props: RecastProps) => void;
  /**
   * 舞台のカードが閉じた。again = もう一度言う(次の発話を聞く)、later = あとで、
   * speech = ボタンを押さずに学習者が話し始めた(次の発話を聞くが、外れても責めない)。
   */
  leaveStage: (how: "again" | "later" | "speech") => void;
  /** 学習者の発話が1つ閉じた。挑戦中の項目があれば照合する。 */
  heard: (utterance: string) => void;
  /** 挑戦中の項目があるか(発話を待っている)。 */
  awaiting: () => boolean;
  /** セッションの始まり。時計を合わせ、前回の項目を捨てる。 */
  reset: () => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

export interface RailOptions {
  host: HTMLElement;
  /** 操作列の「言い直し n」札。レールを閉じているときだけ見える。 */
  openButton: HTMLButtonElement;
  /** レールの「言ってみる」。手動の区切りなら「話す」を押したことにする。 */
  onSayAgain?: () => void;
}

const TAG: Record<RailStatus, string> = {
  onstage: "いま舞台に",
  pending: "あとで",
  awaiting: "言ってみよう",
  done: "言えた",
};

export function createRail(opts: RailOptions): Rail {
  const { host, openButton } = opts;
  const list = host.querySelector(".rail-list") as HTMLElement;
  const tally = host.querySelector(".rail-tally") as HTMLElement;
  const closeBtn = host.querySelector(".rail-close") as HTMLButtonElement;
  const countBadge = openButton.querySelector(".n") as HTMLElement;

  const items: RailItem[] = [];
  let open = true;
  let startedAt = Date.now();

  const elapsed = (ms: number) => {
    const s = Math.max(0, Math.round((ms - startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  const counts = () => ({
    done: items.filter((i) => i.status === "done").length,
    todo: items.filter((i) => i.status !== "done").length,
  });

  const renderItem = (item: RailItem): HTMLElement => {
    const el = document.createElement("div");
    el.className = "rc";
    el.dataset.status = item.status;

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.status === "pending" && item.missed ? "もう一度" : TAG[item.status];
    el.appendChild(tag);

    if (item.status === "onstage") {
      const line = document.createElement("p");
      line.className = "better";
      line.textContent = item.props.better;
      el.appendChild(line);
      return el;
    }

    el.appendChild(renderDiffLine(item.diff.original, "orig"));
    el.appendChild(renderDiffLine(item.diff.better, "better"));

    const row = document.createElement("div");
    row.className = "row";
    const say = document.createElement("button");
    say.type = "button";
    say.className = "say";
    if (item.status === "done") {
      say.disabled = true;
      say.textContent = `✓ 言えた · ${elapsed(item.doneAtMs ?? Date.now())}`;
    } else if (item.status === "awaiting") {
      say.disabled = true;
      say.textContent = "聞いています…";
    } else {
      say.textContent = "言ってみる";
      say.addEventListener("click", () => {
        for (const other of items) if (other.status === "awaiting") other.status = "pending";
        item.status = "awaiting";
        item.implicit = false;
        render();
        opts.onSayAgain?.();
      });
    }
    row.appendChild(say);
    el.appendChild(row);
    return el;
  };

  const render = () => {
    const { done, todo } = counts();
    const any = items.length > 0;
    // 積むものが無いうちはレールも札も出さない。舞台だけの画面(案A)と同じ。
    host.hidden = !any || !open;
    openButton.hidden = !any || open;
    document.body.dataset.rail = any && open ? "open" : "closed";
    countBadge.textContent = String(todo);
    openButton.setAttribute("aria-label", `言い直しのレールを開く(あと ${todo})`);
    tally.replaceChildren();
    const doneEl = document.createElement("b");
    doneEl.textContent = `✓ ${done}`;
    tally.append(doneEl, document.createTextNode(` · あと ${todo}`));
    // 新しいものが上。
    list.replaceChildren(...[...items].reverse().map(renderItem));
  };

  closeBtn.addEventListener("click", () => {
    open = false;
    render();
  });
  openButton.addEventListener("click", () => {
    open = true;
    render();
  });

  const onstage = () => items.find((i) => i.status === "onstage");

  return {
    stage(props) {
      const key = JSON.stringify(props);
      // 前の札がまだ舞台扱いなら、閉じ忘れ。あとで、に落とす。
      const prev = onstage();
      if (prev && prev.key !== key) prev.status = "pending";
      const existing = items.find((i) => i.key === key);
      if (existing) {
        if (existing.status !== "done") existing.status = "onstage";
      } else {
        items.push({ key, props, diff: wordDiff(props.original, props.better), status: "onstage", missed: false, implicit: false });
      }
      render();
    },
    leaveStage(how) {
      const cur = onstage();
      if (!cur) return;
      if (how === "later") {
        cur.status = "pending";
      } else {
        for (const other of items) if (other.status === "awaiting") other.status = "pending";
        cur.status = "awaiting";
        cur.implicit = how === "speech";
      }
      render();
    },
    heard(utterance) {
      const cur = items.find((i) => i.status === "awaiting");
      if (!cur) return;
      if (saidBetter(utterance, cur.diff)) {
        cur.status = "done";
        cur.doneAtMs = Date.now();
      } else {
        cur.status = "pending";
        cur.missed = !cur.implicit;
      }
      render();
    },
    awaiting: () => items.some((i) => i.status === "awaiting"),
    reset() {
      items.length = 0;
      open = true;
      startedAt = Date.now();
      render();
    },
    clear() {
      items.length = 0;
      render();
    },
    setOpen(next) {
      open = next;
      render();
    },
  };
}
