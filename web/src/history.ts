import type { Turn, UiMessage } from "../../shared/messages";
import { createTranscript } from "./transcript";
import { createFeedbackNotebook } from "./feedback";

interface HistorySession { id: string; label: string; started_at: number; status: string }
interface HistoryDetail {
  session: HistorySession;
  turns: Turn[];
  notes: UiMessage[];
  recording: { url: string; expiresAt: number } | null;
}

export function createHistory(button: HTMLButtonElement, dialog: HTMLDialogElement, onImported: () => void = () => {}) {
  const list = dialog.querySelector<HTMLElement>(".history-list")!;
  const detail = dialog.querySelector<HTMLElement>(".history-detail")!;
  const message = dialog.querySelector<HTMLElement>(".history-status")!;
  const more = dialog.querySelector<HTMLButtonElement>(".history-more")!;
  let cursor: string | null = null;
  let generation = 0;
  let available = false;
  const importButton = dialog.querySelector<HTMLButtonElement>(".history-import-open")!;
  const importFile = dialog.querySelector<HTMLInputElement>(".history-import-file")!;
  importButton.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    importButton.disabled = true;
    let completed = 0;
    try {
      if (file.size > 20_000_000) throw new Error("ファイルは20MBまでです");
      const data = JSON.parse(await file.text()) as { format: string; version: number; records: unknown[] };
      if (data.format !== "englishteacher-results" || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 10_000) {
        throw new Error("このアプリから書き出した復習ファイルを選んでください");
      }
      for (const record of data.records) {
        message.textContent = `復習を取り込み中… ${completed} / ${data.records.length}`;
        const response = await fetch("/api/import/results", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record),
        });
        if (!response.ok) throw new Error("取り込みを完了できませんでした。同じファイルから再開できます");
        completed++;
      }
      message.textContent = `${completed}件の復習を取り込みました`;
    } catch (error) {
      message.textContent = `${completed}件まで取り込み済み。${error instanceof Error ? error.message : "ファイルを読み込めませんでした"}`;
    } finally {
      importButton.disabled = false;
      importFile.value = "";
      onImported();
    }
  });

  async function load(append = false) {
    const response = await fetch(`/api/history${append && cursor !== null ? `?before=${encodeURIComponent(cursor)}` : ""}`);
    if (response.status === 404) return;
    if (!response.ok) throw new Error("履歴を読み込めませんでした");
    const data = await response.json() as { sessions: HistorySession[]; next: string | null };
    available = true;
    button.hidden = false;
    if (!append) list.replaceChildren();
    for (const session of data.sessions) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "history-session";
      const label = document.createElement("strong");
      label.textContent = session.label;
      const when = document.createElement("time");
      when.dateTime = new Date(session.started_at).toISOString();
      when.textContent = new Date(session.started_at).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      item.append(label, when);
      item.addEventListener("click", () => void show(session.id));
      list.append(item);
    }
    cursor = data.next;
    more.hidden = cursor === null;
    message.textContent = list.childElementCount ? "" : "練習すると、ここに記録が残ります。";
  }

  async function show(id: string) {
    const current = ++generation;
    message.textContent = "読み込み中…";
    for (const audio of detail.querySelectorAll("audio")) audio.pause();
    detail.replaceChildren();
    try {
      const response = await fetch(`/api/history/${id}`);
      if (!response.ok) throw new Error();
      const data = await response.json() as HistoryDetail;
      if (current !== generation) return;
      const title = document.createElement("h3");
      title.textContent = data.session.label;
      detail.append(title);
      if (["created", "active"].includes(data.session.status)) {
        const end = document.createElement("button");
        end.type = "button";
        end.textContent = "このレッスンを終了";
        end.addEventListener("click", async () => {
          end.disabled = true;
          try {
            const stopped = await fetch("/api/session/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: id }) });
            if (!stopped.ok) throw new Error();
            await show(id);
            await load();
          } catch { message.textContent = "終了できませんでした。もう一度お試しください。"; end.disabled = false; }
        });
        detail.append(end);
      }
      if (data.recording) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = data.recording.url;
        const expiry = document.createElement("p");
        expiry.className = "history-expiry";
        expiry.textContent = `録音の保存期限：${new Date(data.recording.expiresAt).toLocaleDateString("ja-JP")}`;
        audio.addEventListener("error", () => { expiry.textContent = "この録音は再生できません。スクリプトとノートは引き続き読めます。"; });
        detail.append(audio, expiry);
      }
      const columns = document.createElement("div");
      columns.className = "history-columns";
      const script = document.createElement("section");
      const heading = document.createElement("h4");
      heading.textContent = "スクリプト";
      const turns = document.createElement("div");
      turns.className = "history-transcript";
      const transcript = createTranscript(turns);
      data.turns.forEach(turn => transcript.upsert(turn));
      if (!data.turns.length) turns.textContent = "まだ発話の記録はありません。";
      script.append(heading, turns);
      const notes = document.createElement("details");
      notes.className = "history-notes";
      notes.innerHTML = '<summary>ノート <span class="feedback-count">0</span></summary><div class="feedback-list"></div>';
      const notebook = createFeedbackNotebook(notes, Infinity);
      notebook.clear();
      data.notes.forEach(note => notebook.render(note));
      notes.open = true;
      columns.append(script, notes);
      detail.append(columns);
      message.textContent = "";
      turns.scrollTop = 0;
    } catch {
      if (current === generation) message.textContent = "履歴を読み込めませんでした。もう一度お試しください。";
    }
  }

  button.addEventListener("click", () => {
    dialog.showModal();
    void load().catch(() => { message.textContent = "履歴を読み込めませんでした。"; });
  });
  dialog.querySelector<HTMLButtonElement>(".history-close")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    generation++;
    for (const audio of detail.querySelectorAll("audio")) audio.pause();
  });
  more.addEventListener("click", () => void load(true).catch(() => { message.textContent = "履歴を読み込めませんでした。"; }));
  return {
    refresh: () => load().catch(() => { if (!available) button.hidden = true; }),
    setBusy: (busy: boolean) => { button.disabled = busy; },
  };
}
