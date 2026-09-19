/**
 * 話し直しトレーニングの3枚。
 *  - 板(retell_board)   … 舞台の左に居座る。画像と、段階ごとの文字(観点 → キーワード → 質問)。
 *                          画像はサーバーを通らず、選んだ本人のブラウザが持っているものを載せる。
 *  - 改善点(retell_review) … 1〜2個の「あなたの文 → 自然な言い方」。話し直しに入るとサーバーが下げる。
 *  - 比較(retell_compare)  … 舞台をまるごと使う。1回目と2回目の字幕・語数・秒数・要点と、
 *                          改善点が使えたか。録音はブラウザにしか無いので、鳴らすボタンもここ。
 * 文字は textContent だけ(値はモデル由来)。
 */
import type {
  RetellBoardProps,
  RetellCompareProps,
  RetellReviewProps,
  RetellTake,
} from "../../../shared/messages";
import { renderAssessment, renderTeaching } from "./teaching";

/** 改善点のカードを出しておく上限。講評を聞いて読み返す余裕まで。話し直しに入るとサーバーが hide で下げる。 */
export const RETELL_REVIEW_MS = 90_000;

/** 録音を鳴らす手(web/src/takes.ts)。比較のカードが使う。 */
export interface TakePlayer {
  has(label: string): boolean;
  /** 鳴らす。始まりと終わりで onState(true/false) を呼ぶ。別の札が鳴っていれば止めてから。 */
  play(label: string, onState: (playing: boolean) => void): void;
  stop(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chips(items: readonly string[], className = "chips"): HTMLElement {
  const list = el("ul", className);
  for (const item of items) list.appendChild(el("li", "chip", item));
  return list;
}

// ── 板 ────────────────────────────────────────────────────────────────────────

export function renderRetellBoard(props: RetellBoardProps, imageUrl: string | null): HTMLElement {
  const board = el("div", "board");
  board.dataset.phase = props.phase;

  const picture = el("div", "picture");
  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "選んだ画像";
    picture.appendChild(img);
  } else {
    picture.classList.add("empty");
    picture.textContent = "画像";
  }
  board.appendChild(picture);

  board.appendChild(el("div", "board-title", props.title));

  if (props.lines.length > 0) {
    // 2回目はキーワードなので粒で、あとは行で。
    const asChips = props.phase === "retelling" || props.phase === "retold";
    if (asChips) {
      board.appendChild(chips(props.lines, "chips board-lines"));
    } else {
      const list = el("ul", "board-lines");
      for (const line of props.lines) list.appendChild(el("li", "", line));
      board.appendChild(list);
    }
  }
  if (props.note) board.appendChild(el("div", "board-note", props.note));
  return board;
}

// ── 改善点 ────────────────────────────────────────────────────────────────────

export function renderRetellReview(props: RetellReviewProps): HTMLElement {
  const card = el("div", "card review");
  card.appendChild(el("div", "review-head", props.improvements.length > 0 ? "改善点" : "よく伝わりました"));

  if (props.improvements.length > 0) {
    const list = el("ol", "improvements");
    for (const imp of props.improvements) {
      const row = el("li", "");
      const orig = el("div", "orig");
      orig.append(el("span", "who", "あなた"), el("span", "", imp.original));
      row.appendChild(orig);
      row.appendChild(el("div", "better", imp.better));
      if (imp.note) row.appendChild(el("div", "note", imp.note));
      list.appendChild(row);
    }
    card.appendChild(list);
  }

  if (props.points && props.points.length > 0) {
    const points = el("div", "points");
    points.appendChild(el("span", "points-label", "伝わった要点"));
    points.appendChild(chips(props.points));
    card.appendChild(points);
  }
  const assessment = renderAssessment(props.assessment);
  const teaching = renderTeaching(props.teaching);
  if (assessment) card.appendChild(assessment);
  if (teaching) card.appendChild(teaching);
  return card;
}

// ── 比較 ──────────────────────────────────────────────────────────────────────

function takeStats(take: RetellTake): string {
  const parts = [`${take.words} 語`, `${take.seconds} 秒`];
  if (take.hints > 0) parts.push(`ヒント ${take.hints}`);
  return parts.join(" · ");
}

function renderTake(label: string, which: "first" | "second", take: RetellTake, player: TakePlayer | null): HTMLElement {
  const section = el("section", "take");
  section.dataset.which = which;

  const head = el("div", "take-head");
  head.appendChild(el("span", "label", label));
  head.appendChild(el("span", "stats", takeStats(take)));
  if (player?.has(which)) {
    const button = el("button", "play", "▶ 聞く");
    button.type = "button";
    let playing = false;
    button.addEventListener("click", () => {
      if (playing) {
        player.stop();
        return;
      }
      player.play(which, (state) => {
        playing = state;
        button.textContent = state ? "■ 止める" : "▶ 聞く";
        button.classList.toggle("playing", state);
      });
    });
    head.appendChild(button);
  }
  section.appendChild(head);

  if (take.points.length > 0) section.appendChild(chips(take.points));
  section.appendChild(el("p", "transcript", take.transcript || "(字幕なし)"));
  const assessment = renderAssessment(take.assessment);
  if (assessment) section.appendChild(assessment);
  return section;
}

export function renderRetellCompare(props: RetellCompareProps, player: TakePlayer | null): HTMLElement {
  // まとめと同じく舞台をまるごと使う(style.css の :has(.compare) の規則)。
  const card = el("div", "card compare");
  card.appendChild(el("h3", "", props.second ? "1回目 → 2回目" : "1回目"));

  const takes = el("div", "takes");
  takes.appendChild(renderTake("1回目", "first", props.first, player));
  if (props.second) {
    takes.appendChild(renderTake("2回目", "second", props.second, player));
  } else {
    takes.appendChild(el("section", "take missing", "2回目まで行かずに終わりました"));
  }
  card.appendChild(takes);

  if (props.improvements.length > 0) {
    const list = el("ul", "improvements");
    for (const imp of props.improvements) {
      const row = el("li", "");
      if (imp.used !== undefined) row.dataset.used = String(imp.used);
      row.appendChild(el("span", "mark", imp.used === undefined ? "・" : imp.used ? "✓" : "○"));
      const text = el("span", "text");
      text.appendChild(el("span", "better", imp.better));
      text.appendChild(el("span", "orig", `← ${imp.original}`));
      row.appendChild(text);
      row.appendChild(
        el("span", "status", imp.used === undefined ? (props.second ? "判定保留" : "未実施") : imp.used ? "2回目で使えた" : "次は使ってみよう"),
      );
      list.appendChild(row);
    }
    card.appendChild(list);
  }

  if (props.comment) card.appendChild(el("div", "footer", props.comment));
  const teaching = renderTeaching(props.teaching);
  if (teaching) card.appendChild(teaching);
  return card;
}
