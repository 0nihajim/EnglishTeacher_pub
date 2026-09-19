import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { limitedBody, readJson } from "./http";

describe("bounded request bodies", () => {
  it("Content-Lengthがなくても実際のサイズで制限する", async () => {
    await assert.rejects(limitedBody(new Request("https://example.com", { method: "POST", body: "12345" }), 4),
      (error: unknown) => (error as { status: number }).status === 413);
    assert.equal((await limitedBody(new Request("https://example.com", { method: "POST", body: "1234" }), 4)).length, 4);
  });
  it("JSONの配列・null・不正形式を拒否し、サイズエラーを維持する", async () => {
    for (const body of ["[]", "null", "{"]) await assert.rejects(readJson(new Request("https://example.com", { method: "POST", body })));
    await assert.rejects(readJson(new Request("https://example.com", { method: "POST", body: '{"large":true}' }), 3),
      (error: unknown) => (error as { status: number }).status === 413);
  });
});
