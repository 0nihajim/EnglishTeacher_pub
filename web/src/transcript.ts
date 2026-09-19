/**
 * 字幕。1ターン1行、id で引く。途中の更新は同じ行を書き換え、id が変わって
 * 次の行に移る(shared/messages.ts の Turn を参照)。
 *
 * 行の順序について。Gemini は学習者の文字起こしとモデルの返答の順序を保証しない
 * (SDK の注釈にそうある)ので、先生の返答が先に届いて、学習者の行が後から来る
 * ことがある。そのまま末尾に付けると「答えが質問の上に出る」字幕になる。
 * 学習者の行を作るとき、直前が「まだ終わっていない先生の行」なら、その先生の
 * 発話はこの学習者の発話への返答なので、上に差し込む。
 */
import type { Turn } from "../../shared/messages";

export interface Transcript {
  upsert: (turn: Turn) => void;
  /** 直近の先生の行に「途中で切られた」印を付ける。 */
  markInterrupted: () => void;
  clear: () => void;
}

interface Line {
  line: HTMLElement;
  text: HTMLElement;
}

export function createTranscript(el: HTMLElement): Transcript {
  const lines = new Map<string, Line>();
  let lastAssistantLine: HTMLElement | null = null;

  return {
    upsert(turn) {
      let entry = lines.get(turn.id);
      if (!entry) {
        const line = document.createElement("div");
        line.className = `turn ${turn.role}`;
        line.dataset.role = turn.role;
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = turn.role === "user" ? "あなた" : "先生";
        const text = document.createElement("span");
        text.className = "text";
        line.append(who, text);

        const last = el.lastElementChild as HTMLElement | null;
        const replyStillOpen = last?.dataset.role === "assistant" && last.dataset.done !== "true";
        if (turn.role === "user" && last && replyStillOpen) {
          el.insertBefore(line, last);
        } else {
          el.appendChild(line);
        }

        entry = { line, text };
        lines.set(turn.id, entry);
        if (turn.role === "assistant") lastAssistantLine = line;
      }
      entry.text.textContent = turn.text;
      entry.line.dataset.done = String(turn.done);
      el.scrollTop = el.scrollHeight;
    },
    markInterrupted() {
      lastAssistantLine?.classList.add("interrupted");
    },
    clear() {
      el.textContent = "";
      lines.clear();
      lastAssistantLine = null;
    },
  };
}
