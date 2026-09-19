import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FramePacer, appendPoint, exportSize, type Stroke } from "../../shared/strokes";

describe("appendPoint", () => {
  it("先頭の点は必ず入り、近すぎる点は捨てる", () => {
    const stroke: Stroke = { points: [], width: 3, color: "#000" };
    assert.equal(appendPoint(stroke, { x: 10, y: 10 }), true);
    assert.equal(appendPoint(stroke, { x: 10.5, y: 10.5 }), false);
    assert.equal(appendPoint(stroke, { x: 12, y: 10 }), true);
    assert.deepEqual(stroke.points, [{ x: 10, y: 10 }, { x: 12, y: 10 }]);
  });

  it("点は複製して持つ(呼び出し側の再利用に影響されない)", () => {
    const stroke: Stroke = { points: [], width: 3, color: "#000" };
    const p = { x: 1, y: 1 };
    appendPoint(stroke, p);
    p.x = 99;
    assert.equal(stroke.points[0]?.x, 1);
  });
});

describe("exportSize", () => {
  it("長辺を 768 に収め、比率を保つ", () => {
    assert.deepEqual(exportSize(1180, 700), { width: 768, height: 456, scale: 768 / 1180 });
    assert.deepEqual(exportSize(600, 900), { width: 512, height: 768, scale: 768 / 900 });
  });
  it("小さい板は拡大しない", () => {
    assert.deepEqual(exportSize(400, 300), { width: 400, height: 300, scale: 1 });
  });
  it("大きさが無くても 1px は返す", () => {
    assert.deepEqual(exportSize(0, 0), { width: 1, height: 1, scale: 1 });
  });
});

describe("FramePacer", () => {
  const opts = { settleMs: 600, minIntervalMs: 1_000 };

  it("何も変わっていなければ送らない", () => {
    const pacer = new FramePacer(opts);
    assert.equal(pacer.dirty, false);
    assert.equal(pacer.nextSendAt(), null);
    assert.equal(pacer.due(10_000), false);
  });

  it("描き終えて静止した分だけ待ってから送る", () => {
    const pacer = new FramePacer(opts);
    pacer.changed(1_000);
    pacer.changed(1_300); // まだ描いている
    assert.equal(pacer.nextSendAt(), 1_900);
    assert.equal(pacer.due(1_800), false);
    assert.equal(pacer.due(1_900), true);
    pacer.sent(1_900);
    assert.equal(pacer.dirty, false);
    assert.equal(pacer.nextSendAt(), null);
  });

  it("最短間隔を守る: 前の送信から1秒以内は待たされる", () => {
    const pacer = new FramePacer(opts);
    pacer.changed(0);
    pacer.sent(600);
    pacer.changed(700);
    // 静止は 1300 に明けるが、前の送信から 1000ms 空くのは 1600。
    assert.equal(pacer.nextSendAt(), 1_600);
  });

  it("話し始めたら静止を待たない(最短間隔だけは守る)", () => {
    const pacer = new FramePacer(opts);
    pacer.changed(1_000);
    pacer.hurry();
    assert.equal(pacer.nextSendAt(), 1_000);
    pacer.sent(1_000);
    // 急ぎの旗は送信で下りる。次の変化はふつうに静止を待つ(2100 > 前の送信+1000)。
    pacer.changed(1_500);
    assert.equal(pacer.nextSendAt(), 2_100);
  });

  it("未送信の変化が無いときの hurry は何もしない", () => {
    const pacer = new FramePacer(opts);
    pacer.hurry();
    assert.equal(pacer.nextSendAt(), null);
    pacer.changed(5_000);
    // 前の hurry は残っていない。
    assert.equal(pacer.nextSendAt(), 5_600);
  });

  it("reset で最初の状態に戻る", () => {
    const pacer = new FramePacer(opts);
    pacer.changed(0);
    pacer.sent(600);
    pacer.reset();
    pacer.changed(700);
    assert.equal(pacer.nextSendAt(), 1_300);
  });
});
