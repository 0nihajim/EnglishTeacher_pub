/**
 * 生きているセッションの一覧と、放置を刈る見張り。
 *
 * 1プロセス前提。Map 1つで全部で、再起動すれば生きているセッションは消える。
 * 手元で動かす出発点にはこれで足りる。
 */

import { Session } from "./session";

const WATCHDOG_TICK_MS = 5_000;

/**
 * この時間マイク音声が来なければ畳む。マイク音声を唯一の生存信号にしているのは、
 * ブラウザ側が VAD を持たず無音でもフレームを送り続けるから。つまりここで刈るのは
 * 「ブラウザは付いているのに何も送ってこない」セッション(マイク拒否、キャプチャ死)
 * で、それは誰も使えず誰も課金されたくないものだけになる。ブラウザが切断した場合は
 * ws のハンドラが即座に畳む。
 */
const IDLE_TIMEOUT_MS = 60_000;

const sessions = new Map<string, Session>();

export function addSession(session: Session): void {
  sessions.set(session.sessionId, session);
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function liveCount(): number {
  return sessions.size;
}

/**
 * 畳む。Map からの削除が権利の主張なので、ブラウザの停止と見張りが競っても
 * 実行は1回だけ。
 */
export async function stopSession(sessionId: string, reason: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  sessions.delete(sessionId);
  console.log(`[registry] ${sessionId.slice(0, 8)} を停止 (${reason}, 残り ${sessions.size})`);
  await session.stop().catch(() => {});
  return true;
}

/** プロセス終了時に、生きているもの全部を畳む。 */
export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopSession(id, "shutdown")));
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastActivityAt >= IDLE_TIMEOUT_MS) {
      void stopSession(session.sessionId, "idle");
    }
  }
}, WATCHDOG_TICK_MS).unref();
