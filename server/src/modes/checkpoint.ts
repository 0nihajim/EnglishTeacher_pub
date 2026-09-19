/** サーバー自身が作ったチェックポイント用。外部入力として受け付けない。 */
export interface CoachCheckpoint {
  version: 1;
  mode: string;
  state: Record<string, unknown>;
}

export function capture(owner: object, mode: string, keys: readonly string[]): CoachCheckpoint {
  const source = owner as Record<string, unknown>;
  return { version: 1, mode, state: structuredClone(Object.fromEntries(keys.map(key => [key, source[key]]))) };
}

export function restore(owner: object, snapshot: CoachCheckpoint, mode: string, keys: readonly string[]): boolean {
  if (snapshot.version !== 1 || snapshot.mode !== mode || !snapshot.state ||
      !keys.every(key => Object.hasOwn(snapshot.state, key))) return false;
  const target = owner as Record<string, unknown>;
  for (const key of keys) target[key] = structuredClone(snapshot.state[key]);
  return true;
}
