/** 会話用 PCM とは別に、端末のエンコーダーで保存用音声を作る。 */
export interface ConversationRecording { stop(): Promise<Blob | null> }

export async function recordConversation(microphone: MediaStream, teacher: MediaStream, maxBytes: number): Promise<ConversationRecording | null> {
  if (typeof MediaRecorder === "undefined") return null;
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return null;
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const sources = [microphone, teacher].map(stream => context.createMediaStreamSource(stream));
  const gains = sources.map(source => {
    const gain = context.createGain();
    gain.gain.value = 0.7;
    source.connect(gain).connect(destination);
    return gain;
  });
  let recorder: MediaRecorder;
  try {
    await context.resume();
    recorder = new MediaRecorder(destination.stream, { mimeType, audioBitsPerSecond: 64_000 });
  } catch {
    sources.forEach(source => source.disconnect());
    gains.forEach(gain => gain.disconnect());
    destination.stream.getTracks().forEach(track => track.stop());
    await context.close();
    return null;
  }
  const chunks: Blob[] = [];
  let bytes = 0;
  let failed = false;
  let finished = false;
  let resolve!: (blob: Blob | null) => void;
  const stopped = new Promise<Blob | null>(done => { resolve = done; });
  const finish = () => {
    if (finished) return;
    finished = true;
    sources.forEach(source => source.disconnect());
    gains.forEach(gain => gain.disconnect());
    destination.stream.getTracks().forEach(track => track.stop());
    void context.close();
    resolve(failed || !bytes ? null : new Blob(chunks, { type: recorder.mimeType }));
    chunks.length = 0;
  };
  recorder.ondataavailable = event => {
    if (!event.data.size || failed) return;
    bytes += event.data.size;
    if (bytes > maxBytes) {
      failed = true;
      chunks.length = 0;
      if (recorder.state !== "inactive") recorder.stop();
    } else chunks.push(event.data);
  };
  recorder.onerror = () => { failed = true; finish(); };
  recorder.onstop = finish;
  try { recorder.start(1000); } catch { failed = true; finish(); }
  return {
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
      else finish();
      return stopped;
    },
  };
}
