import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticate, requireSameOrigin, type AuthConfig } from "./auth";

const env: AuthConfig = {
  APP_ORIGIN: "https://english.example.com", OWNER_EMAIL: "owner@example.com",
  ACCESS_TEAM_DOMAIN: "test-owner.cloudflareaccess.com", ACCESS_AUD: "our-app",
};
const now = Date.parse("2026-09-18T00:00:00Z");
const pair = await crypto.subtle.generateKey({
  name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
}, true, ["sign", "verify"]) as CryptoKeyPair;
const key = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key", alg: "RS256" };
const claims = {
  iss: `https://${env.ACCESS_TEAM_DOMAIN}`, aud: [env.ACCESS_AUD],
  exp: now / 1000 + 60, sub: "owner-id", email: env.OWNER_EMAIL,
};
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function token(overrides: object = {}, header: object = { alg: "RS256", kid: key.kid }): Promise<string> {
  const unsigned = `${encode(header)}.${encode({ ...claims, ...overrides })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}
const jwks = (async (url: RequestInfo | URL) => {
  assert.equal(String(url), `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [key] }));
}) as typeof fetch;
const request = (jwt: string, url = env.APP_ORIGIN) => new Request(url, { headers: { "Cf-Access-Jwt-Assertion": jwt } });

describe("Cloudflare Access gate", () => {
  it("所有者の正しい署名だけを受け入れる", async () => {
    assert.deepEqual(await authenticate(request(await token()), env, jwks, now), { id: "owner-id", email: env.OWNER_EMAIL });
  });
  it("ヘッダーのメールだけでは認証しない", async () => {
    await assert.rejects(authenticate(new Request(env.APP_ORIGIN, { headers: { "Cf-Access-Authenticated-User-Email": env.OWNER_EMAIL } }), env, jwks, now));
  });
  it("別ユーザー、別アプリ、別発行元、期限切れ、未来の開始時刻を拒否する", async () => {
    for (const override of [
      { email: "someone@example.com" }, { aud: ["other-app"] }, { iss: "https://evil.example" },
      { exp: now / 1000 }, { exp: "9999999999" }, { nbf: now / 1000 + 600 },
    ]) await assert.rejects(authenticate(request(await token(override)), env, jwks, now));
  });
  it("署名改ざんとアルゴリズム変更を拒否する", async () => {
    const signed = await token();
    await assert.rejects(authenticate(request(signed.slice(0, signed.lastIndexOf(".") + 1) + "AAAA"), env, jwks, now));
    await assert.rejects(authenticate(request(await token({}, { alg: "none", kid: key.kid })), env, jwks, now));
  });
  it("未設定・別ドメイン・本番での開発用バイパスを拒否する", async () => {
    const signed = await token();
    await assert.rejects(authenticate(request(signed), { ...env, ACCESS_AUD: "" }, jwks, now));
    await assert.rejects(authenticate(request(signed, "https://alternate.workers.dev"), env, jwks, now));
    await assert.rejects(authenticate(new Request(env.APP_ORIGIN), { ...env, LOCAL_DEV: "true" }, jwks, now));
    assert.equal((await authenticate(new Request("http://127.0.0.1:8787"), { ...env, LOCAL_DEV: "true" })).id, "local-owner");
  });
  it("変更操作とWebSocketのOriginを検証する", () => {
    assert.doesNotThrow(() => requireSameOrigin(new Request(env.APP_ORIGIN, { headers: { Origin: env.APP_ORIGIN } }), env));
    assert.throws(() => requireSameOrigin(new Request(env.APP_ORIGIN), env));
    assert.throws(() => requireSameOrigin(new Request(env.APP_ORIGIN, { headers: { Origin: "https://evil.example" } }), env));
  });
});
