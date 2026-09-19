import { HttpError } from "./http";

export interface AuthConfig {
  APP_ORIGIN: string;
  OWNER_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  LOCAL_DEV?: string;
}

export interface Identity { id: string; email: string }
interface AccessClaims { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; sub?: unknown; email?: unknown; type?: unknown }
interface SigningKey extends JsonWebKey { kid?: string; alg?: string }

const keyCache = new Map<string, { until: number; keys: SigningKey[] }>();
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function decode(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new HttpError(401, "ログインし直してください");
  try {
    return Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  } catch {
    throw new HttpError(401, "ログインし直してください");
  }
}

export async function authenticate(
  request: Request,
  env: AuthConfig,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Identity> {
  const url = new URL(request.url);
  if (env.LOCAL_DEV === "true" && localHosts.has(url.hostname)) {
    return { id: "local-owner", email: env.OWNER_EMAIL };
  }
  // ヘッダーのメールだけは信用しない。署名・発行元・アプリ・期限・所有者をすべて検証する。
  if (!env.ACCESS_AUD || !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) || !env.OWNER_EMAIL) {
    throw new HttpError(503, "ログイン設定の準備中です");
  }
  if (url.origin !== env.APP_ORIGIN) throw new HttpError(403, "この公開先は許可されていません");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16_384) throw new HttpError(401, "ログインしてください");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "ログインし直してください");
  let header: { alg?: unknown; kid?: unknown };
  let claims: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(decode(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(decode(parts[1]!)));
  } catch {
    throw new HttpError(401, "ログインし直してください");
  }
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !claims) {
    throw new HttpError(401, "ログインし直してください");
  }
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (claims.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD) ||
      typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 > now + 30_000)) ||
      typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 200 ||
      typeof claims.email !== "string" || claims.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    throw new HttpError(403, "このアカウントは許可されていません");
  }
  let cache = keyCache.get(issuer);
  if (!cache || cache.until <= now) {
    let response: Response;
    try {
      response = await fetcher(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new HttpError(503, "ログインを確認できません。もう一度お試しください。");
    }
    if (!response.ok) throw new HttpError(503, "ログインを確認できません");
    const jwks = await response.json() as { keys?: SigningKey[] };
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 20) throw new HttpError(503, "ログインを確認できません");
    cache = { keys: jwks.keys, until: now + 5 * 60_000 };
    keyCache.set(issuer, cache);
  }
  const jwk = cache.keys.find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"));
  if (!jwk) {
    keyCache.delete(issuer);
    throw new HttpError(401, "ログインし直してください");
  }
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error();
  } catch {
    throw new HttpError(401, "ログインし直してください");
  }
  return { id: claims.sub, email: claims.email.toLowerCase() };
}

export function requireSameOrigin(request: Request, env: AuthConfig): void {
  const url = new URL(request.url);
  const expected = env.LOCAL_DEV === "true" && localHosts.has(url.hostname) ? url.origin : env.APP_ORIGIN;
  if (request.headers.get("origin") !== expected) throw new HttpError(403, "この操作は許可されていません");
}
