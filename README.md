# English Teacher × Gemini Live

声で英会話を練習するアプリ。日本語話者が英語を話し、教わった表現は会話を止めずにカードで出ます。

## 動かす

Node.js 22.16以上。

1. `cp .env.example .env` して `GEMINI_API_KEY` を埋める([キーの取得](https://aistudio.google.com/apikey))
2. `npm install`
3. `npm run dev` → [http://127.0.0.1:5173](http://127.0.0.1:5173)

`npm run dev` はサーバー(:8787)とブラウザ側(:5173)を同時に上げ、ブラウザ側が `/api` と `/ws` を
中継するので見えるオリジンは1つです。本番相当なら `npm run build` して `npm start`。

APIキーなしで見た目だけ見るなら `npm run dev -w web` を上げて `?demo=recast`(会話中の画面まるごと)か
`?demo=whiteboard`(ボード、実際に描ける)を開きます。単体のカードは `?demo=card`、`?demo=targets`、
`?demo=board`、`?demo=review`、`?demo=compare`。

## モード

「はじめる」の前に4つから選びます。

| モード | 何をするか |
|---|---|
| シーン会話 | 選んだシーンを先生が演じ、使ってほしい表現の機会を作る。使えたかは画面上の帯に出る |
| 瞬間英作文 | 日本語の文が出たら即座に英語で言う。間違えた文は最後にもう一周 |
| 話し直し | 自分の画像1枚について話す → 改善点を1〜2個 → 同じ内容をもう一度。1回5〜8分 |
| ボード | 画面がホワイトボードになり、描きながら英語で話す。板は変化したときだけ先生に届く |

ホームの「今日の復習」は、過去の履歴から期限の来た課題を最大3つ選んで出題します。

練習する中身は `server/scenes/<id>.json` に1ファイルずつ書きます。同梱の `self-intro.json` と
`it-standup.json` が見本です。各モードの画面と進め方、シーンの書式は [モードの詳細](docs/modes.md) にあります。

## 設定

`.env` で変えるもの。全一覧は `.env.example`。

| 変数 | 既定 | 何が変わるか |
|---|---|---|
| `GEMINI_API_KEY` | (必須) | これだけ埋めれば動く |
| `GEMINI_VOICE` | `Kore` | 先生の声(Puck, Charon, Fenrir, Aoede …) |
| `GEMINI_VAD_SILENCE_MS` | `1500` | 学習者がこれだけ黙ると「言い終えた」と判定(区切りが自動のときだけ) |
| `GEMINI_INPUT_LANGUAGES` | `en-US,ja-JP` | 先生が聞く言語。空にすると自動判定 |
| `GEMINI_FLASH_MODEL` | `gemini-3.8-flash` | 話し直しの整理役のモデル |

先生の人格とモードごとの進め方は `server/prompts/*.md` にあります。

## Cloudflare に公開する

[公開手順](docs/cloudflare-setup.md) の通りに `wrangler.jsonc` の `REPLACE_ME` を自分の値
(ホスト名・Account ID・メール・Access の AUD・D1 の ID)に置き換えます。埋め忘れは配信コマンドが
名前を挙げて止めます。1人用の Access 認証、D1 へのスクリプト保存、R2 への録音14日保存が付きます。

`main` への push で `.github/workflows/deploy.yml` が同じ配信をします(Secret に
`CLOUDFLARE_API_TOKEN` が必要。自分で配信しないならこのワークフローは削除してよい)。

## 原価の目安

10分のレッスンで約 $0.14(音声入力 $3.00/1M、出力 $12.00/1M)。ボードを使うと板のフレームが
加わって $0.19 前後。話し直しの Flash 呼び出し2回は数千トークンで、ほとんど動きません。
無料枠のデータは製品改善に使われるので、実運用は有料枠が前提です。音声出力には SynthID の
電子透かしが入ります。

## ドキュメント

- [モードの詳細](docs/modes.md) — 会話中の画面、復習、採点、シーンの書式、話し直し、ボード、発話の区切り
- [実装の中身](docs/internals.md) — ファイル構成、元デモとの対応、移植と実通話で分かったこと
- [未確認の点](docs/status.md) — 実通話・実機で確かめる必要が残っていること。**認証なしで外に出さないこと**
- [Cloudflare 公開手順](docs/cloudflare-setup.md) / [構成](docs/cloudflare-architecture.md)

## 出典とライセンス

[heygen-com/liveavatar-gpt-live-demos](https://github.com/heygen-com/liveavatar-gpt-live-demos)
(MIT © 2026 HeyGen)を Gemini Live API に移植し、教える方向を逆にしたものです。
公式ドキュメントは [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-guide) /
[Tool use](https://ai.google.dev/gemini-api/docs/live-tools) /
[Session management](https://ai.google.dev/gemini-api/docs/live-session)。

MIT。[LICENSE](LICENSE) を参照してください。元実装の著作権表示も残しています。
