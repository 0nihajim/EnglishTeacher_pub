/**
 * ボードのキャンバス(whiteboard モード)。
 *
 * 線は点列(shared/strokes.ts の Stroke)で持ち、2つの大きさで描く:
 *  - 画面。devicePixelRatio に合わせた canvas に、板の座標(CSS px)で描く。
 *  - 先生。長辺 768px の白地 JPEG に描き直し、base64 で送る(Live API の推奨解像度、
 *    1フレーム 258 トークン)。写真のように大きなものは送らない。
 *
 * 送るのは変わったときだけ。ペンが離れて少し静止したら1枚、上限 1枚/秒(FramePacer)。
 * 学習者が話し始めたら静止を待たず、先生が答えるときに最新の板を見ている状態にする。
 *
 * iPad 前提の入力: Pointer Events。Apple Pencil は pointerType "pen"、指は "touch"。
 * 既定はどちらでも描ける。手のひらが触れて線になるなら「ペンのみ」に切り替える。
 * 描いている最中の指のスクロールは CSS の touch-action: none で止める。
 */

import { FramePacer, appendPoint, exportSize, type Point, type Stroke } from "../../shared/strokes";

/** 先生に送る板の長辺。読めなければ 1024(516 トークン)に上げる余地を残す。 */
export const FRAME_LONG_SIDE = 768;
/** 送る JPEG の画質。白地と線だけなので低めで足りる。 */
const FRAME_JPEG_QUALITY = 0.8;
const PEN_WIDTH = 3;
const PEN_COLOR = "#1d2a22";

export interface BoardFrame {
  mimeType: "image/jpeg";
  /** base64(data URL の頭は付かない)。 */
  data: string;
  seq: number;
}

export interface BoardOptions {
  /** 描く面。親要素いっぱいに広げる(CSS)。 */
  canvas: HTMLCanvasElement;
  /** フレームを送る手。null なら送らない(デモ表示)。 */
  send: ((frame: BoardFrame) => void) | null;
  /** 描いた・消した(ツールバーの活性に)。 */
  onChange?: (state: { strokes: number }) => void;
}

export interface Board {
  /** 描けるようにする。ソケットが立ってから。 */
  start(): void;
  /** 描けなくし、板を空にする。 */
  stop(): void;
  clear(): void;
  undo(): void;
  /** ペンだけを受け付ける(手のひら対策)。 */
  setPenOnly(penOnly: boolean): void;
  /** 話し始めた: 未送信の変化があれば静止を待たずに送る。 */
  hurry(): void;
  /** 未送信の変化があるか。 */
  readonly dirty: boolean;
}

export function createBoard(opts: BoardOptions): Board {
  const { canvas } = opts;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("この環境では描けません(canvas 2D が無い)");
  const strokes: Stroke[] = [];
  let current: Stroke | null = null;
  let activePointer: number | null = null;
  let penOnly = false;
  let active = false;
  let seq = 0;
  const pacer = new FramePacer();
  let sendTimer: number | null = null;
  /** 板の大きさ(CSS px)。resize で更新。 */
  let width = 0;
  let height = 0;

  // ── 大きさ ──────────────────────────────────────────────────────────────────
  // 親いっぱいに広げ、DPR ぶんの画素を持たせる。点は CSS px で持っているので、
  // 大きさが変わっても線は同じ位置に描き直せる。

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === width && h === height && canvas.width === Math.round(w * dpr)) return;
    width = w;
    height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    redraw();
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;

  // ── 描画 ────────────────────────────────────────────────────────────────────

  const paintStroke = (target: CanvasRenderingContext2D, stroke: Stroke, scale: number) => {
    const pts = stroke.points;
    if (pts.length === 0) return;
    target.strokeStyle = stroke.color;
    target.lineWidth = stroke.width * scale;
    target.lineCap = "round";
    target.lineJoin = "round";
    target.beginPath();
    const first = pts[0]!;
    if (pts.length === 1) {
      // 点。線として描くと消えるので丸を置く。
      target.fillStyle = stroke.color;
      target.arc(first.x * scale, first.y * scale, (stroke.width * scale) / 2, 0, Math.PI * 2);
      target.fill();
      return;
    }
    target.moveTo(first.x * scale, first.y * scale);
    // 中点を制御点にした2次曲線。240Hz の点列がそのまま折れ線に見えるのを防ぐ。
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      target.quadraticCurveTo(p.x * scale, p.y * scale, ((p.x + q.x) / 2) * scale, ((p.y + q.y) / 2) * scale);
    }
    const last = pts[pts.length - 1]!;
    target.lineTo(last.x * scale, last.y * scale);
    target.stroke();
  };

  const redraw = () => {
    const dpr = canvas.width / Math.max(1, width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) paintStroke(ctx, stroke, dpr);
    if (current) paintStroke(ctx, current, dpr);
  };

  /** 直近の一画だけを重ねる(描いている最中は全部描き直さない)。 */
  const paintCurrentTail = () => {
    if (!current) return;
    const dpr = canvas.width / Math.max(1, width);
    const pts = current.points;
    if (pts.length < 2) {
      redraw();
      return;
    }
    const a = pts[pts.length - 2]!;
    const b = pts[pts.length - 1]!;
    ctx.strokeStyle = current.color;
    ctx.lineWidth = current.width * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.x * dpr, a.y * dpr);
    ctx.lineTo(b.x * dpr, b.y * dpr);
    ctx.stroke();
  };

  // ── 先生に送る ──────────────────────────────────────────────────────────────

  const exportFrame = (): BoardFrame | null => {
    if (!opts.send || width === 0 || height === 0) return null;
    const size = exportSize(width, height, FRAME_LONG_SIDE);
    const out = document.createElement("canvas");
    out.width = size.width;
    out.height = size.height;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, size.width, size.height);
    for (const stroke of strokes) paintStroke(octx, stroke, size.scale);
    if (current) paintStroke(octx, current, size.scale);
    const dataUrl = out.toDataURL("image/jpeg", FRAME_JPEG_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    seq += 1;
    return { mimeType: "image/jpeg", data: dataUrl.slice(comma + 1), seq };
  };

  const cancelSend = () => {
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
  };

  /** pacer の言う時刻に1枚送る。タイマーは1本。呼ぶたびに時刻を見直す。 */
  const scheduleSend = () => {
    cancelSend();
    if (!active || !opts.send) return;
    const at = pacer.nextSendAt();
    if (at === null) return;
    const wait = Math.max(0, at - performance.now());
    sendTimer = window.setTimeout(() => {
      sendTimer = null;
      if (!active || !opts.send) return;
      const now = performance.now();
      if (!pacer.due(now)) {
        scheduleSend();
        return;
      }
      const frame = exportFrame();
      pacer.sent(now);
      if (frame) opts.send(frame);
    }, wait);
  };

  const changed = () => {
    pacer.changed(performance.now());
    opts.onChange?.({ strokes: strokes.length + (current ? 1 : 0) });
    scheduleSend();
  };

  // ── 入力 ────────────────────────────────────────────────────────────────────

  const accepts = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return e.button === 0 || e.buttons === 1;
    if (penOnly) return e.pointerType === "pen";
    return true;
  };

  const local = (e: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onDown = (e: PointerEvent) => {
    if (!active || activePointer !== null || !accepts(e)) return;
    e.preventDefault();
    activePointer = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくても描ける */
    }
    current = { points: [], width: PEN_WIDTH, color: PEN_COLOR };
    appendPoint(current, local(e));
    redraw();
    changed();
  };

  const onMove = (e: PointerEvent) => {
    if (!active || !current || e.pointerId !== activePointer) return;
    e.preventDefault();
    // Pencil の点は 240Hz で来る。coalesced で全部拾い、appendPoint が間引く。
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    let added = false;
    for (const ev of events.length > 0 ? events : [e]) {
      if (appendPoint(current, local(ev))) {
        added = true;
        paintCurrentTail();
      }
    }
    if (added) changed();
  };

  const onUp = (e: PointerEvent) => {
    if (!current || e.pointerId !== activePointer) return;
    e.preventDefault();
    strokes.push(current);
    current = null;
    activePointer = null;
    redraw();
    changed();
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId !== activePointer) return;
    // 途中で取り消された(システムのジェスチャなど)。描いた分は残す。
    onUp(e);
  };

  const listen = () => {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onUp);
    observer?.observe(canvas);
    window.addEventListener("resize", resize);
  };
  const unlisten = () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onCancel);
    canvas.removeEventListener("pointerleave", onUp);
    observer?.disconnect();
    window.removeEventListener("resize", resize);
  };

  const clear = () => {
    if (strokes.length === 0 && !current) return;
    strokes.length = 0;
    current = null;
    activePointer = null;
    redraw();
    changed();
  };

  return {
    start() {
      if (active) return;
      active = true;
      seq = 0;
      pacer.reset();
      listen();
      resize();
      opts.onChange?.({ strokes: 0 });
    },
    stop() {
      if (!active) return;
      active = false;
      cancelSend();
      unlisten();
      strokes.length = 0;
      current = null;
      activePointer = null;
      pacer.reset();
      redraw();
      opts.onChange?.({ strokes: 0 });
    },
    clear,
    undo() {
      if (current) return; // 描いている最中は取り消さない
      if (strokes.pop() === undefined) return;
      redraw();
      changed();
    },
    setPenOnly(next) {
      penOnly = next;
    },
    hurry() {
      if (!active) return;
      pacer.hurry();
      scheduleSend();
    },
    get dirty() {
      return pacer.dirty;
    },
  };
}
