/**
 * カードを描く側。サーバーから来る `{ type: "ui", widget, props }` は全部ここへ
 * 入り、`widget` の switch 1つで振り分ける。ウィジェット1つにモジュール1つで、
 * 既存のウィジェットを使い回すツールを足すならこのディレクトリの追加は0行。
 *
 * 元デモは各カードを独立した HTML(hyperframes の composition)として透過
 * iframe に読み込み、アバターの映像に重ねていた。こちらは重ねる映像が無いので、
 * アプリの DOM に直接描く。依存が2つ(player と GSAP)減り、表示の時間も
 * composition のタイムラインではなくここが持つ。
 *
 * 置き場は3つ。カードは #overlay に1枚ずつ出て、時間が来ると消える(比較だけは居座る)。
 * 表現の一覧(targets)は #targets の帯に、話し直しの板(retell_board)は #board に
 * 居座り、更新のたびに描き直す。
 *
 * 値はモデル由来なので、文字は textContent でしか入れない。
 */
import type { ControlAction, RecastProps, RetellBoardProps, UiMessage } from "../../../shared/messages";
import { DRILL_ANSWER_MS, drillPromptHoldMs, renderDrillAnswer, renderDrillPrompt } from "./drill";
import { renderRecast } from "./recast";
import {
  RETELL_REVIEW_MS,
  renderRetellBoard,
  renderRetellCompare,
  renderRetellReview,
  type TakePlayer,
} from "./retell";
import { SUMMARY_MS, renderSummary } from "./summary";
import { renderTargets } from "./targets";
import { TERM_CARD_MS, renderTermCard } from "./termCard";
import { renderReviewStep } from "./review";

/** 退場アニメーションの長さ。style.css の card-out と合わせる。 */
const LEAVE_MS = 250;

/** 言い直しカードが舞台を離れた理由。レール(rail.ts)がこれで札を決める。 */
export type RecastLeave = "again" | "later" | "speech";

export interface OverlayContext {
  /** #overlay — カードはこの中に入る。 */
  host: HTMLElement;
  /** #targets — シーン会話の表現一覧。カードと違って居座る。 */
  targetsHost: HTMLElement;
  /** #board — 話し直しの板。帯と同じく居座る。 */
  boardHost: HTMLElement;
  /** 話し直しの録音を鳴らす手。無ければ比較に再生ボタンは出ない。 */
  takes?: TakePlayer;
  onControl?: (action: ControlAction) => void;
  /** 言い直しカードが舞台に出た。 */
  onRecast?: (props: RecastProps) => void;
  /** 言い直しカードが舞台を離れた(ボタン、別のカード、hide、学習者の発話)。 */
  onRecastLeave?: (how: RecastLeave) => void;
}

export interface Overlays {
  render: (msg: UiMessage) => void;
  /** カードを消す。帯と板は残る。 */
  hideAll: () => void;
  /** 帯も板も含めて全部消す(セッションの終わり)。 */
  clearAll: () => void;
  /** 話し直しで選んだ画像(data URL)。板に載せる。null で外す。 */
  setImage: (dataUrl: string | null) => void;
  /**
   * 学習者が話し始めた。言い直しカードが出ていれば閉じ、その発話を挑戦として扱う
   * (案D: カードは読んで終わらせず、口に出すまで閉じない — 口に出したら閉じる)。
   */
  learnerSpoke: () => void;
}

export function createOverlays(ctx: OverlayContext): Overlays {
  let autoHide: number | null = null;
  let leaving: number | null = null;
  let imageUrl: string | null = null;
  /** いま出ている板。画像が後から決まったときに描き直すため。 */
  let board: RetellBoardProps | null = null;
  /** 言い直しカードが舞台に出ているか。離れる理由を1回だけ報告するため。 */
  let recastOnStage = false;

  const cancelTimers = () => {
    if (autoHide !== null) clearTimeout(autoHide);
    if (leaving !== null) clearTimeout(leaving);
    autoHide = null;
    leaving = null;
  };

  /** 言い直しが出ていれば「離れた」と報告してから消す。 */
  const releaseRecast = (how: RecastLeave) => {
    if (!recastOnStage) return;
    recastOnStage = false;
    ctx.onRecastLeave?.(how);
  };

  const hideAll = (how: RecastLeave = "later") => {
    cancelTimers();
    ctx.takes?.stop();
    releaseRecast(how);
    const card = ctx.host.firstElementChild;
    if (!card) return;
    card.classList.add("leaving");
    leaving = window.setTimeout(() => {
      leaving = null;
      ctx.host.replaceChildren();
    }, LEAVE_MS);
  };

  const clearAll = () => {
    hideAll();
    ctx.targetsHost.replaceChildren();
    ctx.boardHost.replaceChildren();
    board = null;
  };

  /** holdMs が null なら自分では消えない(比較、言い直し)。 */
  const mount = (card: HTMLElement, holdMs: number | null) => {
    // 退場途中の札が残っていても、新しい札は待たずに置き換える。
    cancelTimers();
    ctx.takes?.stop();
    releaseRecast("later");
    ctx.host.replaceChildren(card);
    if (holdMs === null) return;
    autoHide = window.setTimeout(() => {
      autoHide = null;
      hideAll();
    }, holdMs);
  };

  const mountRecast = (props: RecastProps) => {
    const card = renderRecast(props, {
      onSayAgain: () => hideAll("again"),
      onLater: () => hideAll("later"),
    });
    mount(card, null);
    recastOnStage = true;
    ctx.onRecast?.(props);
  };

  const drawBoard = () => {
    if (board) ctx.boardHost.replaceChildren(renderRetellBoard(board, imageUrl));
  };

  const render = (msg: UiMessage) => {
    switch (msg.widget) {
      case "term_card":
        mount(renderTermCard(msg.props), TERM_CARD_MS);
        break;
      case "recast":
        mountRecast(msg.props);
        break;
      case "drill_prompt":
        mount(renderDrillPrompt(msg.props), drillPromptHoldMs(msg.props));
        break;
      case "drill_answer":
        mount(renderDrillAnswer(msg.props), DRILL_ANSWER_MS);
        break;
      case "review_step":
        mount(renderReviewStep(msg.props, ctx.onControl), null);
        break;
      case "summary":
        mount(renderSummary(msg.props), SUMMARY_MS);
        break;
      case "retell_review":
        mount(renderRetellReview(msg.props), RETELL_REVIEW_MS);
        break;
      case "retell_compare":
        // 終わりの画面。聞き比べている間は消えない(セッションの終了で消える)。
        mount(renderRetellCompare(msg.props, ctx.takes ?? null), null);
        break;
      case "targets":
        // 帯。消えずに、更新のたびに描き直す。
        ctx.targetsHost.replaceChildren(renderTargets(msg.props));
        break;
      case "retell_board":
        board = msg.props;
        drawBoard();
        break;
      case "hide":
        hideAll();
        break;
      default:
        // サーバーが知っていてこのビルドが知らないウィジェット。共有の型が
        // ある意味はこれが起きないことなので、黙らせない。
        console.warn("[overlays] 未知のウィジェット", msg);
        break;
    }
  };

  return {
    render,
    hideAll: () => hideAll("later"),
    clearAll,
    setImage: (dataUrl) => {
      imageUrl = dataUrl;
      drawBoard();
    },
    learnerSpoke: () => {
      if (recastOnStage) hideAll("speech");
    },
  };
}
