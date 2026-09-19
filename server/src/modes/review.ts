import { randomUUID } from "node:crypto";
import type { ReviewOutcome, ReviewPhase, ReviewSeed, ReviewStepProps } from "../../../shared/messages";
import { feedbackText } from "../feedback";
import type { ToolReply } from "../gemini";
import type { ReviewResultRow } from "../results";
import type { Coach, CoachHost } from "./types";
import { capture, restore, type CoachCheckpoint } from "./checkpoint";

const CHECKPOINT_KEYS = ["index", "phase", "greeting", "finished", "attempt", "token", "submitted",
  "attempts", "retries", "assistance", "hint", "note", "said", "outcome", "pending", "results", "runId"] as const;

export const REVIEW_OUTCOME_LABELS: Record<ReviewOutcome, string> = {
  independent: "自力で言えた", repaired: "自分で直せた", hinted: "ヒントで言えた",
  modeled: "お手本の後に言えた", again: "もう一度練習", skipped: "今回はスキップ",
};

/** お手本を丸ごと出さない、決定的な部分ヒント。 */
export function partialHint(answer: string): string {
  const words = answer.trim().split(/\s+/);
  if (answer.length <= 1) return "伝えたい意味と、使う場面を思い出してみよう。";
  if (words.length === 1) return `最初の文字は「${answer[0]}」。`;
  return `${words.slice(0, Math.min(2, words.length - 1)).join(" ")} …`;
}

export function reviewGreeting(total: number): string {
  return `日本語で「今日は${total}つ、前に練習した表現を思い出しましょう」と短く挨拶して止まる。問題や答えはまだ言わない。`;
}

export interface ReviewOptions {
  clock?: () => number;
  onOutcome?: (row: ReviewResultRow) => void;
}

export class ReviewCoach implements Coach {
  checkpoint(): CoachCheckpoint {
    return { ...capture(this, "review", CHECKPOINT_KEYS), activeCard: this.cards[this.index] } as CoachCheckpoint;
  }
  restore(checkpoint: CoachCheckpoint): boolean {
    if (!restore(this, checkpoint, "review", CHECKPOINT_KEYS)) return false;
    this.submitted = false;
    this.pending = null;
    return true;
  }
  private index = 0;
  private phase: ReviewPhase = "recall";
  private greeting = true;
  private finished = false;
  private disposed = false;
  private attempt = 0;
  private token = "";
  private submitted = false;
  private attempts = 0;
  private retries = 0;
  private assistance: "none" | "repair" | "hint" | "model" = "none";
  private hint = "";
  private note = "";
  private said = "";
  private outcome: ReviewOutcome | undefined;
  private pending: string | null = null;
  private readonly results: { card: ReviewSeed; outcome: ReviewOutcome }[] = [];
  private readonly runId = randomUUID();
  private readonly clock: () => number;

  constructor(private readonly host: CoachHost, private readonly cards: readonly ReviewSeed[], private readonly options: ReviewOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  get state(): ReviewPhase | "finished" { return this.finished ? "finished" : this.phase; }
  get attemptId(): string { return this.token; }

  onReady(): void {
    if (this.cards.length) this.show();
  }
  teacherSaid(): void {}
  learnerSaid(text: string): void {
    if (this.acceptsAnswer()) this.said = feedbackText(text);
  }
  learnerSpeechStart(): void {
    if (!this.acceptsAnswer()) return;
    this.submitted = false;
    this.said = "";
  }
  learnerSpeechEnd(): void {
    if (this.acceptsAnswer()) this.submitted = true;
  }
  teacherTurnDone(): void {
    if (this.disposed) return;
    if (this.finished) {
      if (this.pending) {
        const text = this.pending;
        this.pending = null;
        this.host.nudge(text, "now");
      }
      return;
    }
    if (this.greeting) {
      this.greeting = false;
      if (!this.cards.length) this.finish();
      else this.ask("recall");
      return;
    }
    if (this.pending) {
      const text = this.pending;
      this.pending = null;
      this.host.nudge(text, "now");
    }
  }

  onToolCall(name: string, args: Record<string, unknown>): ToolReply {
    const reject = (reason: string): ToolReply => ({ response: { recorded: false, reason }, scheduling: "SILENT" });
    if (name !== "review_result") return reject("unknown tool");
    if (!this.acceptsAnswer() || !this.submitted || args.attempt_id !== this.token) return reject("no submitted attempt with this attempt_id");
    if (!["correct", "close", "wrong", "uncertain"].includes(String(args.verdict))) return reject("invalid verdict");
    this.submitted = false; // 同じ呼び出しを二度数えない。
    this.said = feedbackText(args.said) || this.said;
    if (args.verdict === "uncertain") {
      this.ask(this.phase, "聞き取りを確認したいので、もう一度話してください。");
      return { response: { recorded: false, reason: "unassessed; resubmit using the new attempt_id" }, scheduling: "SILENT" };
    }
    this.attempts++;
    this.note = feedbackText(args.note);
    if (args.verdict === "correct") {
      const outcome: ReviewOutcome = this.assistance === "model" ? "modeled" :
        this.assistance === "hint" ? "hinted" : this.assistance === "repair" ? "repaired" : "independent";
      this.complete(outcome);
    } else if (this.phase === "recall") {
      this.assistance = "repair";
      // 初めの促しには英語を通さない。答えそのものが混ざったら一般的な問いにする。
      const question = feedbackText(args.question, 120);
      this.hint = question && /[ぁ-んァ-ヶ一-龠]/.test(question) && !/[a-z]/i.test(question)
        ? question : "伝えたい意味と、時制・語順を確認してみよう。どう言い直せそうですか？";
      this.ask("repair");
    } else if (this.phase === "repair") {
      this.giveHint();
    } else if (this.phase === "hint") {
      this.reveal();
    } else if (this.phase === "retry") {
      if (this.retries >= 2) this.complete("again");
      else this.reveal();
    }
    return { response: { recorded: true, instruction: "Stop speaking. Follow the app's next instruction." }, scheduling: "SILENT" };
  }

  onControl(action: string): void {
    if (this.disposed || this.finished || this.greeting) return;
    if (action === "next" && this.phase === "done") {
      this.index++;
      if (this.index >= this.cards.length) return this.finish();
      this.attempts = this.retries = 0;
      this.assistance = "none";
      this.hint = this.note = this.said = "";
      this.outcome = undefined;
      this.ask("recall");
    } else if (action === "retry" && this.phase === "model") {
      this.retries++;
      this.hint = "";
      this.ask("retry");
    } else if (action === "skip" && this.phase !== "done") {
      this.complete("skipped");
    } else if (this.acceptsAnswer() && action === "hint") {
      this.giveHint();
    } else if (this.acceptsAnswer() && action === "reveal") {
      this.reveal();
    }
  }

  silenceNudge(): string | null {
    // 自動で答えを見せない。送信後の判定漏れだけ催促する。
    return this.submitted && this.acceptsAnswer()
      ? `送信済みの発話を review_result で判定すること。attempt_id は "${this.token}"。答えを声に出さない。`
      : null;
  }
  dispose(): void { this.disposed = true; this.pending = null; }

  private acceptsAnswer(): boolean {
    return !this.disposed && !this.finished && !this.greeting && ["recall", "repair", "hint", "retry"].includes(this.phase);
  }
  private ask(phase: ReviewPhase, message?: string): void {
    this.phase = phase;
    this.submitted = false;
    this.token = `${this.runId}:${this.index}:${++this.attempt}`;
    const card = this.cards[this.index]!;
    this.show(message);
    const instruction = message ?? (phase === "recall"
      ? `課題を日本語で一度だけ促す: ${card.cue}${card.original ? ` 元の文: ${card.original}` : ""}`
      : phase === "repair" ? `自己修正の問いを日本語で一度だけ言う: ${this.hint}`
      : phase === "hint" ? `部分ヒントを一度だけ言う: ${this.hint}`
      : "お手本は隠れた。「見ないで、もう一度自分の文で話してください」とだけ促す。");
    this.steer(`復習 ${this.index + 1}/${this.cards.length}。phase=${phase}。attempt_id="${this.token}"。\n` +
      `PRIVATE grading data (do not speak or reveal): ${JSON.stringify({ kind: card.kind, cue: card.cue, answer: card.answer, original: card.original })}\n` +
      `${instruction} 答えや訂正文は言わず、送信を待つ。`);
  }
  private giveHint(): void {
    if (this.assistance !== "model") this.assistance = "hint";
    this.hint = partialHint(this.cards[this.index]!.answer);
    this.ask("hint");
  }
  private reveal(): void {
    this.assistance = "model";
    this.phase = "model";
    this.submitted = false;
    this.pending = null;
    const card = this.cards[this.index]!;
    this.show();
    this.steer(`phase=model。ここだけお手本を公開する。${JSON.stringify({
      answer: card.kind === "expression" ? card.teaching?.collocation?.example ?? card.answer : card.answer,
      note: this.note || card.note,
    })} の英文を一度だけ読み、理由を日本語で短く説明する。ボタン操作まで黙って待つ。判定ツールは呼ばない。`);
  }
  private complete(outcome: ReviewOutcome): void {
    this.phase = "done";
    this.outcome = outcome;
    this.submitted = false;
    this.pending = null;
    const card = this.cards[this.index]!;
    this.results.push({ card, outcome });
    this.options.onOutcome?.({
      kind: "review", eventId: `${this.runId}:${this.index}`, at: new Date(this.clock()).toISOString(),
      card, outcome, attempts: this.attempts, ...(this.said ? { said: this.said } : {}),
    });
    this.show();
    this.steer(`${REVIEW_OUTCOME_LABELS[outcome]}。この結果だけを日本語で短く伝え、次へボタンを待つ。新しい課題や例文を言わない。`);
  }
  private steer(text: string): void {
    if (this.host.teacherSpeaking()) this.pending = text;
    else { this.pending = null; this.host.nudge(text, "now"); }
  }
  private show(message?: string): void {
    const card = this.cards[this.index]!;
    const visibleAnswer = this.phase === "model" || this.phase === "done";
    const props: ReviewStepProps = {
      index: this.index + 1, total: this.cards.length, phase: this.phase, cue: card.cue,
      ...(card.original ? { original: card.original } : {}),
      ...(this.said ? { said: this.said } : {}),
      ...(message || ((this.phase === "repair" || this.phase === "hint") && this.hint) ? { hint: message || this.hint } : {}),
      ...(visibleAnswer ? {
        answer: card.answer,
        note: this.note || card.note,
        teaching: card.teaching,
      } : {}),
      ...(this.outcome ? { outcome: this.outcome } : {}),
    };
    this.host.showUi({ widget: "review_step", props });
  }
  private finish(): void {
    this.finished = true;
    this.pending = null;
    this.host.showUi({ widget: "summary", props: {
      title: "今日の復習",
      lines: this.results.map(({ card, outcome }) => ({
        label: card.answer, value: REVIEW_OUTCOME_LABELS[outcome],
        tone: outcome === "independent" || outcome === "repaired" ? "good" : "warn",
      })),
      footer: `${this.results.length}課題を終了 · 自力で言えた ${this.results.filter((r) => r.outcome === "independent").length}`,
    } });
    this.steer("今日の復習は終わり。「おつかれさまでした」と短く締める。新しい課題は出さない。");
  }
}
