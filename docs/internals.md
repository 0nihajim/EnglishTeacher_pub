# 実装の中身

[README](../README.md) に戻る。

## 構成

```
shared/messages.ts    ブラウザ ↔ サーバーの通信規約。ここが契約そのもの
shared/tools.ts       モデルが画面に出せるもの(ツール登録簿)
shared/wordDiff.ts    言い直しの語単位の差分と、「言えた」の照合(テストは server 側)
shared/strokes.ts     ボードの線と、板のフレームをいつ送るかの判断(テストは server 側)

server/src/gemini.ts   Gemini Live との1本の脚。接続の張り替えもここ。画像を渡すのもここ
server/src/session.ts  配線。ブラウザのソケットと Gemini の脚とコーチをつなぐ
server/src/modes/      モードごとの方針(コーチ)。scene = シーン会話、drill = 瞬間英作文、retell = 話し直し、whiteboard = ボード
server/src/flash.ts    話し直しの整理役。Flash に画像と録音を渡し、構造化出力(JSON)で受ける
server/src/image.ts    学習者の画像の検査(中身で種類を決め、大きさを見る)
server/src/takes.ts    「話す」から「送信」までの録音と、WAV のヘッダ
server/src/scenes.ts   server/scenes/*.json の読み込みと検証
server/src/results.ts  結果の記録(data/results/*.jsonl)
server/src/turns.ts    文字起こしの断片からターンを組む
server/src/silence.ts  無音の見張り。先生の再生終了を、届いた音声の長さから見積もる
server/src/tools.ts    表示だけのツール呼び出しを ui メッセージに変える
server/src/index.ts    HTTP と WebSocket の入口
server/src/registry.ts 生きているセッションと放置の刈り取り
server/src/**/*.test.ts 純粋ロジックのテスト(node:test、npm test)
server/scenes/         シーンの定義(ユーザーが書く)
server/prompts/        先生の人格と、モードごとの進め方、整理役への方針

web/src/main.ts          セッション1本を端から端まで
web/src/audioPlayback.ts 先生の声を鳴らす(24kHz PCM を並べる)
web/src/micCapture.ts    マイク → 16kHz PCM16
web/src/image.ts         選んだ画像を縮めて base64 に(話し直し)
web/src/board.ts         ボードの描画と、板を長辺 768px の JPEG に書き出して送る間引き
web/src/takes.ts         自分の発話の録音と再生(話し直しの聞き比べ)
web/src/socket.ts        ブラウザ側のソケット
web/src/liveness.ts      マイクの棒と喋っている光、番の判定に使う声の合図(rAF 1本)
web/src/rail.ts          言い直しレール。閉じた言い直しを積み、再挑戦を文字起こしで照合する
web/src/transcript.ts    字幕(「字幕」を押したときだけ出す)
web/src/overlays/        カードの描画。ウィジェット1つにモジュール1つ(表現の帯、言い直し、出題と判定、まとめ、話し直しの板・改善点・比較)
web/src/style.css        見た目
web/src/demo.ts          ?demo= の見本データ
```

## 元デモとの対応

| デモ | こちら |
|---|---|
| `server/src/gptlive.ts` (534行) | `server/src/gemini.ts` (約310行)。委譲機構が消えた |
| `server/src/liveavatar.ts` | 削除(アバターなし) |
| `server/src/mediaServer.ts` | 削除(同上) |
| `web/src/livekitRoom.ts` | `web/src/audioPlayback.ts` に置き換え |
| `web/public/overlays/*.html` + hyperframes + GSAP | `web/src/overlays/*.ts`(素の DOM と CSS) |
| `shared/tools.ts` の `inferToolName` | 削除。Gemini は名前と id を必ず付ける |

## 移植で分かったこと

**委譲の段が丸ごと消えます。** GPT-Live 版はライブ音声モデルがツールを持たず、画面に
何か出したいときは裏の Responses モデルにターンを渡し、返ってきた言葉をライブ側に
注入していました。Gemini Live はライブモデル自身が function calling を持つので、
`gptlive.ts` と `prompts.ts` の委譲プロンプトが要りません。

**割り込み判定も消えます。** デモは相槌と本当の割り込みを区別するために600ms見張って
音声の途切れ具合で決めていました。Gemini は `serverContent.interrupted` を明示的に
送るので、受けて再生キューを捨てるだけです。

**代わりに音声の再生が増えます。** アバターの声は LiveKit が運んでいたので、ブラウザは
`<audio>` に流すだけでした。顔を捨てた分、24kHz の生 PCM を自分で並べる仕事が
`web/src/audioPlayback.ts` に来ています。移植でいちばん増えた部分です。

**時間制限の扱いが要ります。** 音声のみのセッションは15分、1接続は約10分で切れます。
`contextWindowCompression`(15分の壁を外す)と `sessionResumption`(接続を張り替えても
会話を続ける)の両方を入れてあります。張り替えのとき音声が1秒ほど途切れ、字幕に
「接続を張り替えました」と出ます。

**カードは黙って出させます。** `show_term_card` は `behavior: NON_BLOCKING` で登録し、
結果を `scheduling: SILENT` で返します。これでモデルは喋りを止めずにカードを出し、
「いまカードを出しますね」と言いません。舞台をまるごと使うまとめ(`show_progress`)だけは
`WHEN_IDLE` で、いま話していることを終えてから一覧を読み上げます。

## 実通話で分かったこと

最初の実通話で「先生の声が二重に重なる」「学習者が言い終える前に先生が答える」が出ました。
原因はどれも、この API の性質とコードの前提が食い違っていたことです。

**音声は実時間で届きません。** Gemini は1ターン分の音声を数秒でまとめて送ってきます
(SDK の注釈: "generated as quickly as possible, and not in real time")。ブラウザの
再生キューは発話の長さぶん積み上がるのが正常で、「溜まりすぎ」を理由に今へ寄せると
鳴っている途中の声に次の声が重なります。サーバー側で「先生がいつ喋り終わるか」を知るには、
受信時刻ではなく届いた PCM の長さを積み上げます(`server/src/silence.ts`)。

**進行の差し込みは生成に割り込みます。** `sendClientContent` は `turnComplete` の真偽に
関係なく「生成中なら割り込む」と SDK に明記されています。先生のターンが閉じてから送り、
学習者の番を奪いたくない指示(シーン会話の舵取り)は `turnComplete: false` で文脈に追記だけして、
学習者の次の発話と一緒に処理させます。

**VAD の既定は敏感です。** 開始・終了とも HIGH で、初級者の文中の息継ぎで「言い終えた」に
なります。終了側を LOW、無音 1.5 秒にしてあります(`.env` で調整)。

**setupComplete は connect() が返る前に届きます。** SDK はキューしたメッセージを
`connect()` の resolve 直前に `onmessage` へ流すので、そのハンドラの中では自分の
`session` 変数がまだ入っていません。接続直後にやること(挨拶)は `connect()` の後に
置いてあります。以前はここで挨拶が黙って落ちていました。

## 原価の内訳

音声入力 $3.00/1M(実効 約$0.005/分)、音声出力 $12.00/1M(実効 約$0.018/分)。
学習者と先生が半々に話す10分のレッスンで約$0.14です。無料枠がありますが、無料枠の
データは製品改善に使われるので実運用は有料枠が前提になります。音声出力には SynthID の
電子透かしが入ります。

話し直しでは Flash の呼び出しが1セッションに2回加わります。1回は画像(縮めた1枚で数百〜
1,000 トークン強)と録音(32 トークン/秒、1分で 1,920 トークン)と方針の文で、合わせても
数千トークンです。Live 側に渡す画像も1枚ぶんなので、10 分のレッスンの原価は上の見積もりから
ほとんど動きません。

ボードでは板のフレームが加わります。長辺 768px で1枚 258 トークン、変化したときだけ送るので
10分で数十枚、$0.05 前後です(常時 1fps なら600枚=約155Kトークンで、原価も文脈窓も別の話に
なります)。10分のレッスンで $0.19 前後が見込みです。
