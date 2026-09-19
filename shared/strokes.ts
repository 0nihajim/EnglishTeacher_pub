/**
 * ボード(whiteboard)の線と、板のフレームをいつ送るかの判断。
 *
 * ブラウザの board.ts が使う純粋ロジックをここに置き、server 側の node:test で試す
 * (shared/wordDiff.ts と同じ置き方)。DOM も canvas もここには無い。
 *
 * 線は点列(ベクトル)で持つ。画面には devicePixelRatio に合わせて描き、先生には
 * 長辺 768px の白地 JPEG に描き直して送る(Live API の推奨解像度。1フレーム 258 トークン)。
 * 同じ点列を2つの大きさで描くので、点は「板の座標」(CSS ピクセル)で持つ。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  points: Point[];
  /** 線の太さ(板の座標)。 */
  width: number;
  color: string;
}

/**
 * 点を線に足す。直前の点から minDist 未満しか動いていなければ捨てる(true = 足した)。
 * Apple Pencil は 240Hz で点を出すので、間引かないと1本の線が数千点になる。
 * 先頭の点は必ず入る。
 */
export function appendPoint(stroke: Stroke, point: Point, minDist = 1.5): boolean {
  const last = stroke.points[stroke.points.length - 1];
  if (last) {
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy < minDist * minDist) return false;
  }
  stroke.points.push({ x: point.x, y: point.y });
  return true;
}

/**
 * 板(width x height)を長辺 longSide に収める書き出しの大きさ。板がそれより小さければ
 * 拡大はしない(手書きを引き伸ばしても情報は増えない)。1px 未満にはならない。
 */
export function exportSize(
  width: number,
  height: number,
  longSide = 768,
): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (longest <= 0) return { width: 1, height: 1, scale: 1 };
  const scale = Math.min(1, longSide / longest);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

export interface PacerOptions {
  /** 描き終えてこれだけ静止したら送る。書きかけの一画ごとに送らないため。 */
  settleMs: number;
  /** 送信の最短間隔。Live API のフレームは 1fps が上限。 */
  minIntervalMs: number;
}

export const DEFAULT_PACER: PacerOptions = { settleMs: 600, minIntervalMs: 1_000 };

/**
 * 板のフレームをいつ送るか。
 *
 * 常時 1fps では 10 分で 600 枚(約 155K トークン)になり、文脈窓を圧縮で削り続ける。
 * だから「変わったときだけ」送る: 描いて settleMs 静止したら1枚、上限は minIntervalMs に1枚。
 * 学習者が話し始めたら静止を待たず、先生が答えるときに最新の板を見ている状態にする。
 *
 * 時計は外から渡す(テストのため)。setTimeout は呼ぶ側が持つ。
 */
export class FramePacer {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  /** 未送信の変化が最後にあった時刻。null = 送るものが無い。 */
  private changedAt: number | null = null;
  /** 話し始めた: 静止を待たない。次の送信で下りる。 */
  private urgent = false;

  constructor(private readonly opts: PacerOptions = DEFAULT_PACER) {}

  /** 板が変わった(点が増えた、消した)。 */
  changed(now: number): void {
    this.changedAt = now;
  }

  /** 学習者が話し始めた。未送信の変化があれば静止を待たずに送る。 */
  hurry(): void {
    if (this.changedAt !== null) this.urgent = true;
  }

  /** 未送信の変化があるか。 */
  get dirty(): boolean {
    return this.changedAt !== null;
  }

  /**
   * 次に送るべき時刻。送るものが無ければ null。
   * 静止待ち(急ぎなら省く)と最短間隔の、遅いほう。
   */
  nextSendAt(): number | null {
    if (this.changedAt === null) return null;
    const settled = this.urgent ? this.changedAt : this.changedAt + this.opts.settleMs;
    return Math.max(settled, this.lastSentAt + this.opts.minIntervalMs);
  }

  /** now に送ってよいか(nextSendAt を過ぎた)。 */
  due(now: number): boolean {
    const at = this.nextSendAt();
    return at !== null && now >= at;
  }

  /** 送った。変化は無かったことになる。 */
  sent(now: number): void {
    this.lastSentAt = now;
    this.changedAt = null;
    this.urgent = false;
  }

  /** 板を捨てた(セッションの終わり)。 */
  reset(): void {
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.changedAt = null;
    this.urgent = false;
  }
}
