/** Durable Object の再生成でも残るストレージと、直列化されたリクエストを模擬する。 */
export function testState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let blocked: Promise<unknown> = Promise.resolve();
  const waits: Promise<unknown>[] = [];
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === "string") values.set(key, structuredClone(value));
      else for (const [name, entry] of Object.entries(key)) values.set(name, structuredClone(entry));
    },
    async delete(key: string) { return values.delete(key); },
    async list({ prefix }: { prefix: string }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)));
    },
    async setAlarm(at: number) { alarm = at; },
    async deleteAlarm() { alarm = null; },
  };
  const ctx = {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      const run = blocked.then(callback);
      blocked = run.catch(() => {});
      return run;
    },
    waitUntil(promise: Promise<unknown>) { waits.push(promise); },
  } as unknown as DurableObjectState;
  return { ctx, values, alarm: () => alarm, drain: () => Promise.all(waits) };
}
