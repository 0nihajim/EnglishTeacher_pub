import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { base64Bytes, ImageError, MAX_FRAME_BYTES, parseBoardFrame, parseLearnerImage, sniffImage } from "./image";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP_HEAD = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "ascii");

describe("sniffImage", () => {
  it("JPEG・PNG・WebP を先頭バイトで見分け、知らないものは undefined", () => {
    assert.equal(sniffImage(JPEG_HEAD), "image/jpeg");
    assert.equal(sniffImage(PNG_HEAD), "image/png");
    assert.equal(sniffImage(WEBP_HEAD), "image/webp");
    assert.equal(sniffImage(Buffer.from("GIF89a")), undefined);
    assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WAVEfmt ")), undefined);
    assert.equal(sniffImage(Buffer.alloc(0)), undefined);
  });
});

describe("base64Bytes", () => {
  it("パディングを数に入れない", () => {
    assert.equal(base64Bytes(Buffer.alloc(3).toString("base64")), 3);
    assert.equal(base64Bytes(Buffer.alloc(4).toString("base64")), 4);
    assert.equal(base64Bytes(Buffer.alloc(5).toString("base64")), 5);
    assert.equal(base64Bytes(""), 0);
  });
});

describe("parseLearnerImage", () => {
  it("中身で種類を決める。宣言された mime_type は見ない", () => {
    const data = Buffer.concat([PNG_HEAD, Buffer.alloc(100)]).toString("base64");
    const image = parseLearnerImage({ mime_type: "image/jpeg", data });
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.bytes, 116);
    assert.equal(image.data, data);
  });

  it("無い・空・base64 でない・知らない形式・大きすぎるは断る", () => {
    assert.throws(() => parseLearnerImage(undefined), ImageError);
    assert.throws(() => parseLearnerImage({ mime_type: "image/png" }), /空/);
    assert.throws(() => parseLearnerImage({ data: "not base64!!" }), /base64/);
    assert.throws(() => parseLearnerImage({ data: Buffer.from("GIF89a....").toString("base64") }), /JPEG・PNG・WebP/);
    const huge = "A".repeat(8 * 1024 * 1024 + 4);
    assert.throws(() => parseLearnerImage({ data: huge }), /大きすぎ/);
  });
});

describe("parseBoardFrame", () => {
  it("画像と同じ検査で、上限だけ 1MB", () => {
    const data = Buffer.concat([JPEG_HEAD, Buffer.alloc(100)]).toString("base64");
    const frame = parseBoardFrame({ type: "board_frame", mime_type: "image/png", data, seq: 1 });
    assert.equal(frame.mimeType, "image/jpeg");
    assert.equal(frame.bytes, 112);
    assert.throws(() => parseBoardFrame({ data: Buffer.alloc(MAX_FRAME_BYTES + 3).toString("base64") }), /1MB/);
    assert.throws(() => parseBoardFrame(null), ImageError);
    assert.throws(() => parseBoardFrame({ data: Buffer.from("GIF89a....").toString("base64") }), /JPEG/);
  });
});
