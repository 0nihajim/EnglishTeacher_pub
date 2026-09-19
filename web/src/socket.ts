/**
 * ブラウザ側のソケット。マイク音声が上り、先生の音声・字幕・カードが下る。
 *
 * 元デモとの違いは `onAudio` があること。デモではアバターの音声が LiveKit で
 * 別経路に来ていたので、このソケットは音を運んでいなかった。
 */
import type { ClientMessage, ControlAction, ServerMessage, Turn, UiMessage } from "../../shared/messages";

export interface SessionSocketHandlers {
  onReady: () => void;
  onTurn: (turn: Turn) => void;
  onUi: (msg: UiMessage) => void;
  /** 先生の声。base64 PCM16 24kHz。 */
  onAudio: (base64: string) => void;
  /** 割り込まれた。再生待ちの音声はもう来ない。 */
  onInterrupted: () => void;
  /** 失敗ではない連絡(接続の張り替えなど)。 */
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onReconnecting?: () => void;
}

export interface SessionSocket {
  sendMicAudio: (base64: string) => void;
  endMicStream: () => void;
  /** 手動の区切り: 「話す」を押した。ここからの音声が先生に届く。 */
  speechStart: () => void;
  /** 手動の区切り: 「送信」を押した。先生はここで答え始める。 */
  speechEnd: () => void;
  /** 画面の操作(スキップ、ヒント)。モードが解釈する。 */
  control: (action: ControlAction) => void;
  /** ボード: 板の現在の姿を1枚。間引きはブラウザ側(board.ts)が済ませている。 */
  sendBoardFrame: (frame: { mimeType: string; data: string; seq: number }) => void;
  close: () => void;
}

export function openSessionSocket(
  wsPath: string,
  handlers: SessionSocketHandlers,
  resumePath?: string,
): SessionSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket;
  let closedByUs = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnecting = false;
  const delays = [500, 1000, 2000, 4000, 8000];

  const receive = (event: MessageEvent<string>) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        attempts = 0;
        reconnecting = false;
        handlers.onReady();
        break;
      case "turn":
        handlers.onTurn(msg);
        break;
      case "ui":
        handlers.onUi(msg);
        break;
      case "audio":
        handlers.onAudio(msg.audio);
        break;
      case "interrupted":
        handlers.onInterrupted();
        break;
      case "notice":
        handlers.onNotice(msg.message);
        break;
      case "error":
        handlers.onError(msg.message);
        break;
    }
  };

  const reconnect = () => {
    if (closedByUs) return;
    if (!resumePath || attempts >= delays.length) {
      handlers.onError("接続を復旧できませんでした。保存済みの内容は履歴から確認できます");
      handlers.onClose();
      return;
    }
    reconnecting = true;
    handlers.onReconnecting?.();
    handlers.onInterrupted();
    handlers.onNotice("再接続中です。接続が戻ってから話してください");
    retryTimer = setTimeout(async () => {
      try {
        const response = await fetch(resumePath, { method: "POST" });
        if (!response.ok) {
          if (response.status === 410 || response.status === 404) {
            handlers.onClose();
            return;
          }
          throw new Error("Reconnect failed");
        }
        const data = await response.json() as { ws_path: string };
        if (!closedByUs) connect(data.ws_path);
      } catch { reconnect(); }
    }, delays[attempts++]);
  };
  const connect = (path: string) => {
    const current = new WebSocket(`${proto}://${location.host}${path}`);
    ws = current;
    current.onmessage = receive;
    current.onerror = () => { /* close から再接続する */ };
    current.onclose = event => {
      if (closedByUs || current !== ws) return;
      if (event.code === 1000) handlers.onClose();
      else reconnect();
    };
  };
  connect(wsPath);

  const send = (payload: ClientMessage) => {
    if (!reconnecting && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  return {
    sendMicAudio: (audio) => send({ type: "mic_audio", audio }),
    endMicStream: () => send({ type: "mic_end" }),
    speechStart: () => send({ type: "speech_start" }),
    speechEnd: () => send({ type: "speech_end" }),
    control: (action) => send({ type: "control", action }),
    sendBoardFrame: ({ mimeType, data, seq }) => send({ type: "board_frame", mime_type: mimeType, data, seq }),
    close: () => {
      closedByUs = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      // 閉じること自体が終了の合図。サーバーは close でセッションを畳む。
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    },
  };
}
