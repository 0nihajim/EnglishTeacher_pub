/**
 * セッション1本を端から端まで持つ: モードとシーンを選ぶ → 開始 → 再生の用意 →
 * ソケット → マイク、そして片付けを正しい順で。
 *
 * 上げる順が意味を持つ。マイクはサーバーが `ready` と言ってから始める。上流の
 * セッションが立つ前に送った音声は捨てられる。再生側は逆にソケットより前に
 * 用意する。開幕の挨拶は `ready` の直後に届き、そのとき鳴らす先が無いと
 * 最初の一言が消える。
 *
 * 起動は世代番号で守る。下の await はどれも「その間に停止を押せる窓」であり、
 * 古い起動が片付け済みの資源を掴み直してはいけない。
 */

import "./style.css";
import type { ControlAction, Mode, RetellPhase, ReviewPhase, SceneSummary, StartRequest, StartResponse, Turn, TurnTaking } from "../../shared/messages";
import { createAudioPlayback, primeAudioContext, type AudioPlayback } from "./audioPlayback";
import { createBoard } from "./board";
import { demoImageUrl, demoSample } from "./demo";
import { prepareImage, type PickedImage } from "./image";
import { createLiveness } from "./liveness";
import { startMicCapture, type MicCapture } from "./micCapture";
import { createOverlays } from "./overlays/index";
import { createRail } from "./rail";
import { openSessionSocket, type SessionSocket } from "./socket";
import { createTakeStore } from "./takes";
import { createTranscript } from "./transcript";
import { createFeedbackNotebook } from "./feedback";
import { createDailyReview } from "./review";
import { createHistory } from "./history";
import { recordConversation, type ConversationRecording } from "./recording";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>("stage");
const hero = $<HTMLDivElement>("hero");
const loader = $<HTMLDivElement>("loader");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const skipBtn = $<HTMLButtonElement>("skip");
const statusEl = $<HTMLDivElement>("status");
const loaderLabel = $<HTMLSpanElement>("loader-label");
const micBtn = $<HTMLButtonElement>("mic");
const micLabel = micBtn.querySelector(".label") as HTMLSpanElement;
const sceneSel = $<HTMLSelectElement>("scene");
const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("#modes .mode"));
const turnBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("#turn-taking .opt"));
const turnGroup = $<HTMLDivElement>("turn-taking");
const hintBtn = $<HTMLButtonElement>("hint");
const scenePick = $<HTMLLabelElement>("scene-pick");
const imagePick = $<HTMLLabelElement>("image-pick");
const imageFile = $<HTMLInputElement>("image-file");
const imagePreview = $<HTMLImageElement>("image-preview");
const imageText = $<HTMLSpanElement>("image-text");
const turnLabel = stage.querySelector(".turn-label") as HTMLParagraphElement;
const turnSub = stage.querySelector(".turn-sub") as HTMLParagraphElement;
const captionEl = $<HTMLParagraphElement>("caption");
const transcriptPanel = $<HTMLElement>("transcript-panel");
const transcriptToggle = $<HTMLButtonElement>("transcript-toggle");
const whiteboardEl = $<HTMLDivElement>("whiteboard");
const wbCanvas = whiteboardEl.querySelector(".wb-canvas") as HTMLCanvasElement;
const wbUndo = whiteboardEl.querySelector(".wb-undo") as HTMLButtonElement;
const wbClear = whiteboardEl.querySelector(".wb-clear") as HTMLButtonElement;
const wbPenOnly = whiteboardEl.querySelector(".wb-pen-only") as HTMLButtonElement;
const wbSent = whiteboardEl.querySelector(".wb-sent") as HTMLSpanElement;

/** 通話中の案内。番の表示の下の一行。区切りの方式と、手動なら発話が開いているか、話し直しなら段階で変わる。 */
function listeningLabel(): string {
  if (reviewSession) {
    if (talking) return "言い終えたら「送信」";
    if (reviewFinished) return "復習完了 · 終了してホームへ";
    if (reviewPhase === "model") return "確認できたら「隠して、もう一度話す」";
    if (reviewPhase === "done") return "振り返りを確認して、次へ";
    return "答えを見ずに、話してみよう";
  }
  if (whiteboardSession) {
    if (manual) return talking ? "言い終えたら「送信」" : "描いて、「話す」を押して説明しよう";
    return "描きながら、そのまま話せばいい";
  }
  if (!manual) return "話し終えたら、少し待つだけ";
  if (talking) {
    return "言い終えたら「送信」";
  }
  switch (retellPhase) {
    case "greeting":
    case "telling":
      return "画像について話そう · 30〜60秒";
    case "analyzing":
      return "振り返りを準備中…";
    case "reviewing":
      return "フィードバック";
    case "retelling":
      return "同じ内容を、もう一度";
    case "answering":
      return "質問に答えよう";
    case "finished":
      return "練習完了";
    default:
      return "「話す」を押して、話し始める";
  }
}

/** 操作列の左の小さな状態。接続と区切りの方式。案内は番の表示(turn-sub)が持つ。 */
function connectionLabel(): string {
  if (audioLocked) return "画面を1回タップすると先生の声が出ます";
  return manual ? "接続中 · 送信ボタンで区切る" : "接続中 · 自動で区切る";
}

type StatusKind = "idle" | "busy" | "live" | "error";
const setStatus = (msg: string, kind: StatusKind = "idle") => {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
  // 接続中は、同じ文言をローダー側にも出す。
  if (stage.dataset.state === "connecting") loaderLabel.textContent = msg;
};

/** 通話中の表示を揃える: 状態は接続、案内は番の表示。通話中でなければ何もしない。 */
function refreshLive(): void {
  if (!socket || stopping || stage.dataset.state !== "live") return;
  setStatus(connectionLabel(), audioLocked ? "busy" : "live");
  renderTurn();
}

/**
 * 先生の声が止まっているか(iOS で、開始のタップの効力が切れたとき)。
 * 音声は次のタップで鳴り出すので、失敗ではなく案内として出す。
 */
let audioLocked = false;

// ── 番の表示 ──────────────────────────────────────────────────────────────────
// 舞台の中央。「先生が話している / あなたの番 / 聞いている」を大きく見せる(案D)。
// 先生 = 先生のターンの字幕が開いている、または先生の声が鳴っている。
// 聞いている = 学習者の発話が閉じてから、先生が動き出すまで。
// あなたの番 = それ以外。長く「聞いている」が続くときは番を返す(先生が答えない事故の保険)。

type TurnState = "teacher" | "you" | "thinking";
const THINKING_MAX_MS = 12_000;

let assistantOpen = false;
let teacherVoice = false;
let awaitingReply = false;
let thinkingTimer: number | null = null;
/** いま開いている学習者のターン。話し始めを1回だけ拾うため。 */
let userTurnId: string | null = null;
/** 直近の先生のターン。割り込みで切られたときに、その一文をキャプションに出さないため。 */
let assistantTurnId: string | null = null;
/** 途中で切られた先生のターン。キャプションに出さない。 */
let interruptedTurnId: string | null = null;

function turnState(): TurnState {
  if (assistantOpen || teacherVoice) return "teacher";
  if (awaitingReply) return "thinking";
  return "you";
}

function setAwaitingReply(next: boolean): void {
  awaitingReply = next;
  if (thinkingTimer !== null) clearTimeout(thinkingTimer);
  thinkingTimer = null;
  if (next) {
    thinkingTimer = window.setTimeout(() => {
      thinkingTimer = null;
      awaitingReply = false;
      renderTurn();
    }, THINKING_MAX_MS);
  }
}

function renderTurn(): void {
  const state = turnState();
  stage.dataset.turn = state;
  if (reviewSession && micBtn.disabled && !reviewFinished) {
    turnLabel.textContent = "確認しよう";
    turnSub.textContent = listeningLabel();
    return;
  }
  switch (state) {
    case "teacher":
      turnLabel.textContent = "先生が話しています";
      turnSub.textContent = "聞くだけでいい";
      break;
    case "thinking":
      turnLabel.textContent = "聞いています…";
      turnSub.textContent = "";
      break;
    case "you":
      turnLabel.textContent = manual && talking ? "話しています" : "あなたの番";
      turnSub.textContent = listeningLabel();
      break;
  }
}

function resetTurnState(): void {
  assistantOpen = false;
  teacherVoice = false;
  setAwaitingReply(false);
  userTurnId = null;
  assistantTurnId = null;
  interruptedTurnId = null;
  captionEl.hidden = true;
  captionEl.textContent = "";
  renderTurn();
}

/** 字幕1行から、番とキャプションと言い直しの挑戦を更新する。字幕そのものは transcript が描く。 */
function observeTurn(turn: Turn): void {
  if (turn.role === "assistant") {
    assistantTurnId = turn.id;
    assistantOpen = !turn.done;
    if (!turn.done) {
      // 話し始め。前の一文は下げる(話している最中は読ませない)。
      captionEl.hidden = true;
      captionEl.textContent = "";
    } else if (turn.id !== interruptedTurnId && turn.text.trim()) {
      captionEl.textContent = turn.text;
      captionEl.hidden = false;
    }
    if (!turn.done) setAwaitingReply(false);
  } else {
    if (turn.id !== userTurnId) {
      userTurnId = turn.id;
      setAwaitingReply(false);
      // 学習者が話し始めた。言い直しカードが出ていれば閉じ、この発話を挑戦として聞く。
      overlays.learnerSpoke();
      // ボード: 先生が答えるとき最新の板を見ているように、未送信の変化を静止待ちなしで送る。
      board.hurry();
    }
    if (turn.done) {
      rail.heard(turn.text);
      if (!assistantOpen && !teacherVoice) setAwaitingReply(true);
    }
  }
  renderTurn();
}

// ── 字幕の開閉 ────────────────────────────────────────────────────────────────
// 会話中は既定で閉じる(自分の文を読みながら話すと口が止まる)。「字幕」で右の欄に出す。
// 開いている間は言い直しレールを引っ込める。同じ場所を使うため。

let transcriptOpen = false;

function renderTranscriptPanel(): void {
  const live = stage.dataset.state === "live";
  transcriptPanel.hidden = !(transcriptOpen && live);
  document.body.dataset.transcript = transcriptOpen ? "open" : "closed";
  transcriptToggle.setAttribute("aria-pressed", String(transcriptOpen));
  transcriptToggle.textContent = transcriptOpen ? "字幕を閉じる" : "字幕";
}

function setTranscriptOpen(next: boolean): void {
  transcriptOpen = next;
  if (next) rail.setOpen(false);
  renderTranscriptPanel();
}

transcriptToggle.addEventListener("click", () => setTranscriptOpen(!transcriptOpen));

/** idle → hero、connecting → ローダー、live → 番の表示(style.css 参照)。 */
const setStage = (state: "idle" | "connecting" | "live") => {
  stage.dataset.state = state;
  hero.hidden = state !== "idle";
  hero.inert = state !== "idle";
  loader.hidden = state !== "connecting";
  loader.setAttribute("aria-hidden", String(state !== "connecting"));
  dailyReview.setBusy(state !== "idle");
  history.setBusy(state !== "idle");
  renderTranscriptPanel();
};

/** 話し直しの録音(1回目・2回目)。比較のカードから鳴らす。 */
const takes = createTakeStore();
/** 言い直しレール。舞台のカードを離れた言い直しを積む。「言ってみる」は手動なら「話す」を兼ねる。 */
const rail = createRail({
  host: $("rail"),
  openButton: $<HTMLButtonElement>("rail-open"),
  onSayAgain: () => {
    if (manual && !talking) void setTalking(true);
  },
});
$<HTMLButtonElement>("rail-open").addEventListener("click", () => setTranscriptOpen(false));
const overlays = createOverlays({
  host: $("overlay"),
  targetsHost: $("targets"),
  boardHost: $("board"),
  takes,
  onControl: reviewControl,
  onRecast: rail.stage,
  onRecastLeave: (how) => {
    rail.leaveStage(how);
    // 「もう一度言う」は、手動の区切りなら「話す」も兼ねる。
    if (how === "again" && manual && !talking) void setTalking(true);
  },
});
const transcript = createTranscript($("transcript"));
const feedback = createFeedbackNotebook($<HTMLDetailsElement>("feedback-panel"));
const liveness = createLiveness({
  stage,
  wave: stage.querySelector(".wave") as HTMLCanvasElement,
  level: micBtn,
  onVoice: (speaking) => {
    teacherVoice = speaking;
    if (speaking) setAwaitingReply(false);
    renderTurn();
  },
});
const dailyReview = createDailyReview($("daily-review"), () => void start("review"));
const history = createHistory($<HTMLButtonElement>("history-open"), $<HTMLDialogElement>("history-dialog"), () => void dailyReview.refresh());

// ── ボード ────────────────────────────────────────────────────────────────────
// 学習者が描くキャンバス。フレームは変わったときだけ、いまのソケットへ(board.ts が間引く)。
// 舞台に居座るのでセッションの寿命と合わせる(onReady で start、stop で stop)。

let framesSent = 0;
const board = createBoard({
  canvas: wbCanvas,
  send: (frame) => {
    if (!socket) return;
    socket.sendBoardFrame(frame);
    framesSent = frame.seq;
    wbSent.textContent = `先生に見せた板: ${framesSent}`;
  },
  onChange: ({ strokes }) => {
    wbUndo.disabled = strokes === 0;
    wbClear.disabled = strokes === 0;
  },
});
wbUndo.addEventListener("click", () => board.undo());
wbClear.addEventListener("click", () => board.clear());
wbPenOnly.addEventListener("click", () => {
  const next = wbPenOnly.getAttribute("aria-pressed") !== "true";
  wbPenOnly.setAttribute("aria-pressed", String(next));
  board.setPenOnly(next);
});

// ── モードとシーン ────────────────────────────────────────────────────────────
// 選ぶのは開始前だけ。シーン会話と瞬間英作文はシーンが要るので、サーバーから一覧が来るまで
// 始められない(サーバーが無いデモ表示では一覧が来ないので、そのまま)。話し直しは画像が要る。
// ボードは何も要らない。

const isMode = (v: unknown): v is Mode => v === "scene" || v === "drill" || v === "retell" || v === "whiteboard";

let mode: Mode = "scene";
let sceneIds: string[] = [];

function setMode(next: Mode): void {
  mode = next;
  for (const btn of modeBtns) btn.setAttribute("aria-pressed", String(btn.dataset.mode === next));
  scenePick.hidden = next === "retell" || next === "whiteboard";
  imagePick.hidden = next !== "retell";
  renderTurnTaking();
  refreshStart();
}

/** 開始ボタンの可否。シーンが1つも無ければ、話し直しなら画像を選ぶまで、押せない。ボードはいつでも。 */
function refreshStart(): void {
  if (stage.dataset.state !== "idle") return;
  if (mode === "whiteboard") startBtn.disabled = false;
  else startBtn.disabled = mode === "retell" ? pickedImage === null : sceneIds.length === 0;
}

for (const btn of modeBtns) {
  btn.addEventListener("click", () => {
    const next = btn.dataset.mode;
    setMode(isMode(next) ? next : "scene");
  });
}

async function loadScenes(): Promise<void> {
  try {
    const response = await fetch("/api/scenes");
    if (!response.ok) throw new Error(String(response.status));
    const { scenes } = (await response.json()) as { scenes: SceneSummary[] };
    sceneIds = scenes.map((s) => s.id);
    const options = scenes.map((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.title;
      return opt;
    });
    if (options.length === 0) {
      const opt = document.createElement("option");
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "選べるシーンがありません";
      options.push(opt);
    }
    sceneSel.replaceChildren(...options);
  } catch {
    // サーバーが無い(デモ表示など)。シーンのモードは選べないままにする。
  }
  refreshStart();
}

// ── 画像(話し直し) ───────────────────────────────────────────────────────────
// 選んだ画像はブラウザで縮めてから送る(image.ts)。縮めた絵は板にも載せるので持っておく。
// セッションが終わっても残す — 同じ画像でもう一度、が自然な使い方。

const IMAGE_PICK_TEXT = "画像を選ぶ・ドロップ";

let pickedImage: PickedImage | null = null;

async function chooseImage(file: File | Blob | null | undefined): Promise<void> {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("画像ファイルを選んでください", "error");
    return;
  }
  imageText.textContent = "読み込み中…";
  try {
    const picked = await prepareImage(file);
    pickedImage = picked;
    imagePreview.src = picked.dataUrl;
    imagePreview.hidden = false;
    imageText.textContent = "画像を変更";
    imagePick.dataset.picked = "";
    if (stage.dataset.state === "idle") setStatus("待機中", "idle");
  } catch (err) {
    pickedImage = null;
    imagePreview.hidden = true;
    delete imagePick.dataset.picked;
    imageText.textContent = IMAGE_PICK_TEXT;
    setStatus(err instanceof Error ? err.message : "画像を読めませんでした", "error");
  }
  refreshStart();
}

imageFile.addEventListener("change", () => {
  const file = imageFile.files?.[0];
  imageFile.value = ""; // 同じファイルをもう一度選べるように
  void chooseImage(file);
});
imagePick.addEventListener("dragover", (e) => {
  e.preventDefault();
  imagePick.dataset.drag = "";
});
imagePick.addEventListener("dragleave", () => {
  delete imagePick.dataset.drag;
});
imagePick.addEventListener("drop", (e) => {
  e.preventDefault();
  delete imagePick.dataset.drag;
  void chooseImage(e.dataTransfer?.files?.[0]);
});
// スクリーンショットは貼り付けが速い。開始前で、話し直しを選んでいるときだけ。
document.addEventListener("paste", (e) => {
  if (mode !== "retell" || stage.dataset.state !== "idle") return;
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  void chooseImage(item.getAsFile());
});

// ── 発話の区切り ──────────────────────────────────────────────────────────────
// 自動 = Gemini の VAD が黙ったのを見て先生が答える。手動 = 「話す」と「送信」を
// 学習者が押す。接続時に決まるので選ぶのは開始前だけ。選択は次回も残す。
// 話し直しは手動に固定(先生が最後まで待つのが前提)。切り替えは押せないまま見せる。

const TURN_TAKING_KEY = "turnTaking";
const isTurnTaking = (v: unknown): v is TurnTaking => v === "auto" || v === "manual";

let turnTaking: TurnTaking = "auto";

function renderTurnTaking(): void {
  const forced = mode === "retell";
  const effective: TurnTaking = forced ? "manual" : turnTaking;
  for (const btn of turnBtns) {
    btn.setAttribute("aria-pressed", String(btn.dataset.turnTaking === effective));
    btn.disabled = forced;
  }
  turnGroup.setAttribute("aria-disabled", String(forced));
}

function setTurnTaking(next: TurnTaking): void {
  turnTaking = next;
  renderTurnTaking();
  try {
    localStorage.setItem(TURN_TAKING_KEY, next);
  } catch {
    // 保存できない環境(プライベートモードなど)。今回の選択は効く。
  }
}

function savedTurnTaking(): TurnTaking {
  try {
    const saved = localStorage.getItem(TURN_TAKING_KEY);
    return isTurnTaking(saved) ? saved : "auto";
  } catch {
    return "auto";
  }
}

for (const btn of turnBtns) {
  btn.addEventListener("click", () => {
    const next = btn.dataset.turnTaking;
    setTurnTaking(isTurnTaking(next) ? next : "auto");
  });
}

// ── マイクのボタン ────────────────────────────────────────────────────────────
// 自動の区切りではミュート。トラックを無効にするだけで、無音は流れ続ける
// (micCapture 参照)。あわせて mic_end を送り、上流に「いま言い終えた」と伝える。
// 無音を待たせるより先生の反応が速くなる。
// 手動の区切りでは同じボタンが「話す」と「送信」になる(下の setTalking)。

let micMuted = false;

function setMicMuted(muted: boolean): void {
  micMuted = muted;
  mic?.setMuted(muted);
  liveness.setMicMuted(muted);
  if (muted) {
    micBtn.dataset.muted = "";
    socket?.endMicStream();
  } else {
    delete micBtn.dataset.muted;
  }
  micBtn.setAttribute("aria-pressed", String(muted));
  const label = muted ? "マイクのミュートを解除" : "マイクをミュート";
  micBtn.title = label;
  micBtn.setAttribute("aria-label", label);
}

/** このセッションの区切りが手動か。開始の応答で決まり、停止で戻る。 */
let manual = false;
/** 手動の区切り: 「話す」を押してから「送信」まで true。 */
let talking = false;
let sendingSpeech = false;

function renderMicButton(): void {
  if (!manual) {
    delete micBtn.dataset.manual;
    delete micBtn.dataset.talking;
    micLabel.textContent = "";
    return; // 文言と aria はミュート側(setMicMuted)が持つ
  }
  micBtn.dataset.manual = "";
  if (talking) micBtn.dataset.talking = "";
  else delete micBtn.dataset.talking;
  micLabel.textContent = talking ? "送信" : "話す";
  const label = talking ? "言い終えた — 先生に送る" : "話し始める";
  micBtn.title = label;
  micBtn.setAttribute("aria-label", label);
  micBtn.setAttribute("aria-pressed", String(talking));
}

/**
 * 「話す」(true)と「送信」(false)。音声そのものは常に送っていて、サーバーが
 * この合図の間だけ先生に渡す。だから「送信」では、まとめ待ちの音声を出し切って
 * から合図を送る — 発話の末尾が合図の後ろに回って切れないように。
 * 話し直しでは同じ区間をブラウザ側でも録る(比較のカードで聞き比べる)。
 */
async function setTalking(next: boolean): Promise<void> {
  if (!manual || !mic || !socket || talking === next || sendingSpeech) return;
  if (next && micBtn.disabled) return;
  talking = next;
  renderMicButton();
  for (const button of document.querySelectorAll<HTMLButtonElement>(".retrieval-actions button")) button.disabled = true;
  // 送っていない間は棒を灰色に。ミュートと同じ見せ方で「届いていない」を示す。
  liveness.setMicMuted(!next);
  if (next) {
    if (retellSession) takes.begin(takeLabel(retellPhase));
    socket.speechStart();
    // 話し始めた。言い直しカードが出ていれば閉じ、この発話を挑戦として聞く。
    setAwaitingReply(false);
    overlays.learnerSpoke();
    // ボード: 先生に、いまの板を見せてから聞かせる。
    board.hurry();
    refreshLive();
    return;
  }
  sendingSpeech = true;
  const sentGeneration = generation;
  // ボード: 送信の直前に変えた板も、答えより先に届くように。
  board.hurry();
  await mic.flush();
  if (sentGeneration !== generation) return;
  // flush の間に停止していれば socket は無い。
  socket?.speechEnd();
  sendingSpeech = false;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".retrieval-actions button")) button.disabled = false;
  takes.end();
  if (!assistantOpen && !teacherVoice) setAwaitingReply(true);
  refreshLive();
}

// ── 話し直し: 段階とヒント ──────────────────────────────────────────────────
// 段階はサーバーの板(retell_board)に載って届く。ヒントが押せるのは学習者が話す番だけ。
// 録音の札は段階から決める(1回目 = first、2回目 = second)。

const HINT_PHASES: ReadonlySet<RetellPhase> = new Set(["telling", "retelling", "answering"]);

/** このセッションが話し直しか(開始の応答で決まる)。 */
let retellSession = false;
let retellPhase: RetellPhase | null = null;
/** このセッションがボードか。舞台をキャンバスに明け渡す。 */
let whiteboardSession = false;
let reviewSession = false;
let reviewPhase: ReviewPhase | null = null;
let reviewFinished = false;

function renderReviewState(): void {
  document.body.toggleAttribute("data-review-active", reviewSession && !reviewFinished);
  micBtn.disabled = !mic || (reviewSession && (reviewFinished || reviewPhase === "model" || reviewPhase === "done"));
  refreshLive();
}

function reviewControl(action: ControlAction): void {
  if (!reviewSession || !socket || talking || sendingSpeech) return;
  // お手本の再生予約も止めてから、答えを隠した課題へ移る。
  playback?.flush();
  socket.control(action);
}

function setRetellPhase(phase: RetellPhase | null): void {
  retellPhase = phase;
  hintBtn.hidden = !retellSession;
  hintBtn.disabled = phase === null || !HINT_PHASES.has(phase);
  refreshLive();
}

function takeLabel(phase: RetellPhase | null): string {
  switch (phase) {
    case "greeting":
    case "telling":
      return "first";
    case "retelling":
      return "second";
    case "answering":
      return "answer";
    default:
      return phase ?? "other";
  }
}

hintBtn.addEventListener("click", () => socket?.control("hint"));

micBtn.addEventListener("click", () => {
  if (!mic) return;
  if (manual) void setTalking(!talking);
  else setMicMuted(!micMuted);
});

// 手動の区切りではスペースキーでも切り替える。ボタンやフォーム部品にフォーカスが
// あるときは、その部品の動き(ボタンならクリック)に任せて二重にしない。
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || !manual || !mic) return;
  const target = e.target as HTMLElement | null;
  if (target && /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(target.tagName)) return;
  if (micBtn.disabled) return;
  e.preventDefault();
  void setTalking(!talking);
});

// ── セッションの寿命 ──────────────────────────────────────────────────────────

let sessionId: string | null = null;
let socket: SessionSocket | null = null;
let playback: AudioPlayback | null = null;
let mic: MicCapture | null = null;
let recording: ConversationRecording | null = null;
let generation = 0;
let stopping = false;
let noticeTimer: number | null = null;
/** サーバーから届いた直近のエラー。ソケットが閉じた後もこの文言を残す。 */
let lastError: string | null = null;

async function start(requestedMode: Mode = mode): Promise<void> {
  if (stage.dataset.state !== "idle") return;
  // ここはまだ「はじめる」のタップの中(最初の await より前)。iOS は操作の直後だけ
  // 音声を起こせるので、通信を待つ前に AudioContext を作っておく。
  primeAudioContext();
  const myGeneration = ++generation;
  const superseded = () => generation !== myGeneration;

  startBtn.disabled = true;
  lastError = null;
  setStage("connecting");
  setStatus("セッションを開始中…", "busy");
  liveness.start();

  const body: StartRequest = { mode: requestedMode, turn_taking: requestedMode === "retell" || requestedMode === "review" ? "manual" : turnTaking };
  if (requestedMode === "retell") {
    if (!pickedImage) {
      setStage("idle");
      setStatus("写真かスクリーンショットを1枚選んでください", "error");
      refreshStart();
      return;
    }
    body.image = { mime_type: pickedImage.mimeType, data: pickedImage.data };
  } else if (requestedMode !== "review" && requestedMode !== "whiteboard") {
    body.scene_id = sceneSel.value;
  }

  let started: StartResponse & { error?: string };
  try {
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    started = (await response.json()) as typeof started;
    if (!response.ok) throw new Error(started.error ?? "セッションを開始できませんでした");
  } catch (err) {
    setStage("idle");
    setStatus(err instanceof Error ? err.message : "セッションを開始できませんでした", "error");
    refreshStart();
    if (requestedMode === "review") void dailyReview.refresh();
    return;
  }

  if (superseded()) {
    void endOnServer(started.session_id);
    return;
  }
  sessionId = started.session_id;
  // サーバーが適用した区切り。古いサーバーは返さないので、その場合は自動。
  manual = started.turn_taking === "manual";
  talking = false;
  sendingSpeech = false;
  retellSession = started.mode === "retell";
  whiteboardSession = started.mode === "whiteboard";
  reviewSession = started.mode === "review";
  reviewPhase = null;
  reviewFinished = false;
  // 舞台の見た目はモードで変わる(ボードはキャンバスが主役)。
  stage.dataset.mode = started.mode;
  // 板に載せる画像はサーバーを通さない。選んだものをそのまま。
  if (retellSession && pickedImage) overlays.setImage(pickedImage.dataUrl);

  // ソケットより先に再生を用意する。挨拶は ready の直後に来る。
  setStatus("音声を準備中…", "busy");
  try {
    playback = await createAudioPlayback({
      onLocked: (locked) => {
        audioLocked = locked;
        refreshLive();
      },
    });
  } catch (err) {
    await stop(err instanceof Error ? `音声を出せません: ${err.message}` : "音声を出せません", "error");
    return;
  }
  if (superseded()) {
    void playback.close();
    playback = null;
    return;
  }
  liveness.attachVoice(playback.analyser);

  setStatus("先生に接続中…", "busy");
  let readyOnce = false;
  let micStarting = false;
  socket = openSessionSocket(started.ws_path, {
    onReady: () => {
      if (superseded()) return;
      if (!readyOnce) {
        feedback.clear();
        rail.reset();
        resetTurnState();
      }
      readyOnce = true;
      setStage("live");
      refreshLive();
      renderMicButton();
      // 手動では「話す」まで何も届いていない。棒を灰色にしてそう見せる。
      if (manual) liveness.setMicMuted(true);
      stopBtn.disabled = false;
      // スキップは瞬間英作文だけ。ヒントは話し直しだけ(段階が届くまでは押せない)。
      skipBtn.hidden = started.mode !== "drill";
      skipBtn.disabled = started.mode !== "drill";
      setRetellPhase(retellPhase);
      renderReviewState();
      // ボード: ソケットが立ったので描いてよい。張り替え後の ready でも板は残す(start は冪等)。
      if (whiteboardSession) {
        whiteboardEl.hidden = false;
        board.start();
      }
      if (mic || micStarting) return;
      micStarting = true;
      void startMicCapture((base64) => {
        socket?.sendMicAudio(base64);
        takes.push(base64); // 「話す」と「送信」の間だけ溜まる
      })
        .then(async (capture) => {
          // getUserMedia は実時間がかかる。その窓でセッションが終わっていたら、
          // ここで保持するとマイクのランプが点いたまま消す手が無くなる。
          if (superseded()) {
            capture.stop();
            return;
          }
          mic = capture;
          liveness.attachMic(capture.analyser);
          renderReviewState();
          if (started.recording?.enabled && playback) {
            const archive = await recordConversation(capture.stream, playback.recordingStream, started.recording.maxBytes);
            if (superseded()) void archive?.stop();
            else recording = archive;
          }
        })
        .catch((err: unknown) => {
          setStatus(
            err instanceof Error ? `マイクが使えません: ${err.message}` : "マイクが使えません",
            "error",
          );
        }).finally(() => { micStarting = false; });
    },
    onTurn: (turn) => {
      transcript.upsert(turn);
      observeTurn(turn);
    },
    onUi: (msg) => {
      overlays.render(msg);
      feedback.render(msg);
      if (msg.widget === "review_step") {
        reviewPhase = msg.props.phase;
        renderReviewState();
      } else if (reviewSession && msg.widget === "summary") {
        reviewFinished = true;
        renderReviewState();
        void dailyReview.refresh();
      }
      // 板は段階も運んでくる。ヒントの可否と録音の札はここから。
      if (msg.widget === "retell_board") setRetellPhase(msg.props.phase);
    },
    onAudio: (base64) => {
      if (!playback) return;
      playback.push(base64);
      // 予約の深さは発話の長さに応じて伸びるのが正常(audioPlayback.ts 冒頭)。
      // 途中で縮んだら重ね掛けが再発している。
      if (import.meta.env.DEV) {
        console.debug(`[playback] 予約 ${playback.queuedSeconds().toFixed(2)}s 先まで`);
      }
    },
    onInterrupted: () => {
      // 続きは来ない。溜まっている音声を捨て、字幕にもそう出す。切られた一文はキャプションにも出さない。
      playback?.flush();
      transcript.markInterrupted();
      interruptedTurnId = assistantTurnId;
      assistantOpen = false;
      captionEl.hidden = true;
      renderTurn();
    },
    onNotice: (message) => {
      setStatus(message, "busy");
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        noticeTimer = null;
        refreshLive();
      }, 2_500);
    },
    onError: (message) => {
      lastError = message;
      setStatus(message, "error");
    },
    onClose: () => {
      // サーバーが畳んだ。直前にエラーを伝えてきていれば、その文言のまま終える。
      if (!stopping) void stop(lastError ?? "セッションが終了しました", lastError ? "error" : "idle");
    },
    onReconnecting: () => {
      talking = false;
      sendingSpeech = false;
      takes.end();
      renderMicButton();
      micBtn.disabled = true;
      assistantOpen = false;
      setAwaitingReply(false);
      renderTurn();
    },
  }, started.resume_path);
}

async function stop(reason?: string, kind: StatusKind = "idle"): Promise<void> {
  generation += 1; // 進行中の起動を打ち切る
  if (stopping) return;
  stopping = true;
  stopBtn.disabled = true;
  skipBtn.hidden = true;
  skipBtn.disabled = true;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = null;

  const savedAudio = recording?.stop();
  recording = null;
  mic?.stop();
  mic = null;
  socket?.close();
  socket = null;
  await playback?.close();
  playback = null;
  audioLocked = false;
  overlays.clearAll();
  overlays.setImage(null);
  takes.clear();
  liveness.stop();
  board.stop();
  whiteboardEl.hidden = true;
  wbSent.textContent = "";
  framesSent = 0;
  delete stage.dataset.mode;
  micBtn.disabled = true;
  manual = false;
  talking = false;
  sendingSpeech = false;
  retellSession = false;
  whiteboardSession = false;
  reviewSession = false;
  reviewPhase = null;
  reviewFinished = false;
  renderReviewState();
  setRetellPhase(null);
  renderMicButton();
  setMicMuted(false);
  // 字幕はセッションと同じ寿命。開始時ではなくここで消す。レールと番の表示も同じ。
  transcript.clear();
  rail.clear();
  resetTurnState();

  const id = sessionId;
  sessionId = null;
  if (id) void (async () => {
    await endOnServer(id);
    const audio = await savedAudio;
    if (audio) {
      try {
        const response = await fetch(`/api/recordings/${id}`, { method: "POST", headers: { "Content-Type": audio.type }, body: audio });
        if (!response.ok) throw new Error("Recording upload failed");
      } catch {
        if (stage.dataset.state === "idle") setStatus("録音を保存できませんでした。スクリプトとノートは履歴から確認できます", "error");
      }
    }
    await Promise.allSettled([dailyReview.refresh(), history.refresh()]);
  })();

  setStage("idle");
  setStatus(reason ?? "待機中", kind);
  refreshStart();
  stopping = false;
}

async function endOnServer(id: string): Promise<void> {
  try {
    await fetch("/api/session/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id }),
    });
  } catch {
    // サーバー側の見張りが畳むので、ここで回復すべきものは無い。
  }
}

// タブを閉じるとセッションが残る(サーバーの見張りが刈るまで)。
// unload を生き延びるのは sendBeacon だけで、fetch は取り消される。
window.addEventListener("pagehide", () => {
  if (!sessionId) return;
  navigator.sendBeacon?.(
    "/api/session/stop",
    new Blob([JSON.stringify({ session_id: sessionId })], { type: "application/json" }),
  );
});

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", () => void stop());
skipBtn.addEventListener("click", () => socket?.control("skip"));

setMode("scene");
setTurnTaking(savedTurnTaking());
void loadScenes();
void dailyReview.refresh();
void history.refresh();
window.addEventListener("focus", () => {
  if (stage.dataset.state === "idle" && !new URLSearchParams(location.search).has("demo")) void dailyReview.refresh();
});

// ── 開発用の口 ────────────────────────────────────────────────────────────────
// API を叩かずにカードの見た目だけ確かめられる。
//   window.__ui({ widget: "term_card", props: { term: "Could you say that again?",
//     reading: "クッジュー・セイ・ザッ・アゲン", meaning: "もう一度言ってもらえますか" } })
Object.assign(window, { __ui: overlays.render, __stage: setStage });

// 同じことを URL からも(/?demo=card、/?demo=targets、/?demo=drill、/?demo=board …)。
// カードは自分で消えるので、見ている間は出し直す。
// /?demo=whiteboard はウィジェットではなく画面そのもの: キャンバスに描けて、言い直しが1枚重なる。
if (new URLSearchParams(location.search).get("demo") === "whiteboard") {
  setStage("live");
  setStatus("デモ表示(サーバーには繋いでいません)", "live");
  stage.dataset.mode = "whiteboard";
  whiteboardSession = true;
  whiteboardEl.hidden = false;
  board.start();
  wbSent.textContent = "デモ: 先生には送りません";
  renderTurn();
  overlays.render({
    widget: "recast",
    props: { original: "The API talk to database.", better: "The API talks to the database.", note: "三単現の s と、特定のものには the", kind: "correction" },
  });
}
const sample = demoSample(location.search);
if (sample) {
  setStage("live");
  setStatus("デモ表示(サーバーには繋いでいません)", "live");
  renderTurn();
  if (sample.widget.startsWith("retell_")) {
    // 話し直しの見本は板と一緒に。画像は canvas で描いた見本。
    overlays.setImage(demoImageUrl());
    const board = demoSample("?demo=board");
    if (board && sample.widget !== "retell_board") overlays.render(board);
  }
  if (sample.widget === "recast") {
    // 言い直しの見本は会話中の画面まるごと: 帯、先生の一文、レール(言えた1・あとで1)、そしてカード。
    const targets = demoSample("?demo=targets");
    if (targets) overlays.render(targets);
    captionEl.textContent = "Nice. So what's blocking you on the login bug?";
    captionEl.hidden = false;
    overlays.render({ widget: "recast", props: { original: "I am work the login bug.", better: "I'm working on the login bug." } });
    overlays.learnerSpoke();
    rail.heard("I'm working on the login bug");
    overlays.render({ widget: "recast", props: { original: "I check it later.", better: "I'll follow up on it later.", note: "follow up で「あとで確認する」" } });
    overlays.hideAll();
  }
  overlays.render(sample);
  feedback.render(sample);
  // 自分で消えるカードは、見ている間は出し直す(言い直しは押すまで残るので出し直さない)。
  if (sample.widget !== "recast") setInterval(() => overlays.render(sample), 5_000);
}
