/**
 * 環境変数の読み取り。リポジトリ直下の .env 1枚が全部を決める。
 * ブラウザにはどれも渡らない。
 */

const env = (name: string, fallback = ""): string => process.env[name] ?? fallback;

/**
 * "en-US, ja-JP" のようなカンマ区切りを言語コードの配列にする。空白と空要素と
 * 重複は落とす。空文字なら [](= 言語は自動判定に任せる)。
 */
export function parseLanguages(value: string): string[] {
  const seen = new Set<string>();
  for (const raw of value.split(/[,\s]+/)) {
    const code = raw.trim();
    if (code) seen.add(code);
  }
  return [...seen];
}

export const config = {
  port: Number(env("PORT", "8787")),

  gemini: {
    apiKey: env("GEMINI_API_KEY"),
    /**
     * 既定は gemini-3.8-live。背景推論を効かせたいなら
     * gemini-3.8-live-extended-thinking にする。ただし後者は
     * NON_BLOCKING 固定で function scheduling が効かない(SILENT を指定できない)
     * ので、カードを出すたびにモデルがそれに言及しうる点に注意。
     */
    model: env("GEMINI_LIVE_MODEL", "gemini-3.8-live"),
    /**
     * 話し直しトレーニングで、説明の整理と振り返りに使う通常のマルチモーダルモデル。
     * 画像と学習者の音声を渡し、構造化出力(JSON)で改善点・キーワード・追加の質問を受け取る。
     * 会話そのものは Live が持ち、こちらは会話の合間に1回ずつ呼ぶだけ。
     */
    flashModel: env("GEMINI_FLASH_MODEL", "gemini-3.8-flash"),
    /**
     * 話し直しで、学習者の画像を Live に渡す経路。
     *  realtime = sendRealtimeInput({ video })。公式ドキュメントが画像に使っている経路(既定)
     *  content  = 挨拶の指示と同じ clientContent の inlineData。順序は保証されるが公式には未記載
     * 実通話で先生が「画像が見えない」と言うなら、もう一方に切り替えて試す。
     */
    imageVia: (env("GEMINI_IMAGE_VIA", "realtime").toLowerCase() === "content" ? "content" : "realtime") as
      | "realtime"
      | "content",
    voice: env("GEMINI_VOICE", "Kore"),
    /** GEMINI_DEBUG=1 で受信イベントを全部ログに出す。音声の中身は伏せる。 */
    debug: Boolean(env("GEMINI_DEBUG")),
    /**
     * 発話区間検出(VAD)の調整。Gemini Live の既定は開始・終了とも HIGH で、
     * 初級者の文中の息継ぎで「言い終えた」と判定され、学習者が話し終える前に
     * 先生が答え始める。終了側は常に LOW にし、無音の必要時間をここで決める。
     * 小声で発話が開かなくなったら、まず開始側を HIGH に戻す。
     */
    vad: {
      silenceMs: Number(env("GEMINI_VAD_SILENCE_MS")) || 1_500,
      startSensitivity: (env("GEMINI_VAD_START_SENSITIVITY", "LOW").toUpperCase() === "HIGH"
        ? "HIGH"
        : "LOW") as "LOW" | "HIGH",
    },
    /**
     * 学習者の音声に含まれうる言語(BCP-47)。文字起こしへのヒントとして渡し、
     * 同じ内容を system instruction にも書く。既定は英語と日本語で、それ以外に
     * 聞こえた発話も英語か日本語として扱わせる。空にすると自動判定に戻る。
     *
     * 文字起こしのヒント(inputAudioTranscription.languageCodes)は SDK の型には
     * あるが公式ドキュメントに記載が無く、上流が受け付けない可能性がある。
     * 受け付けなければ gemini.ts がヒントを外して繋ぎ直し、ログに残す。
     */
    inputLanguages: parseLanguages(env("GEMINI_INPUT_LANGUAGES", "en-US,ja-JP")),
  },
};

/** 足りない必須変数の名前。起動時に警告、セッション開始時は 500 で名前を返す。 */
export function missingConfig(): string[] {
  const required: [string, string][] = [["GEMINI_API_KEY", config.gemini.apiKey]];
  return required.filter(([, value]) => !value).map(([name]) => name);
}
