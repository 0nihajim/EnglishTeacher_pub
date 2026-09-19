# English Teacher × Gemini Live

声で英会話を練習するアプリ。日本語話者が英語を話し、教わった表現は会話を止めずにカードで出ます。

## 使えるようにする

必要なもの: Node.js 22.16以上、Gemini API キー([取得](https://aistudio.google.com/apikey))。

1. `cp .env.example .env` して `GEMINI_API_KEY=` に自分のキーを書く
2. `npm install`
3. `npm run dev`
4. [http://127.0.0.1:5173](http://127.0.0.1:5173) を開き、モードとシーンを選んで「はじめる」を押す

マイクの許可を求められたら許可します。ヘッドホンを使ってください(スピーカーだと先生の声を
マイクが拾います)。これで話せます。

モードは4つ(シーン会話・瞬間英作文・話し直し・ボード)。何がどう違うかは
[モードの詳細](docs/modes.md) にあります。練習する表現を自分で足すなら
`server/scenes/<id>.json` を1ファイル書きます(同梱の `it-standup.json` が見本)。

## 自分のサーバーで公開する

手元のサーバー版に認証はありません。そのまま外に出すと誰でもセッションを開けて、課金はあなたの
API キーに乗ります。外に出すなら [Cloudflare 公開手順](docs/cloudflare-setup.md) を使ってください
(1人用の Access 認証つき)。`wrangler.jsonc` の `REPLACE_ME` を自分の値に置き換える形で、
埋め忘れは配信コマンドが名前を挙げて止めます。

## 詳しく

- [モードの詳細](docs/modes.md) — 会話中の画面、復習、採点、シーンの書式、`.env` で変えられるもの
- [実装の中身](docs/internals.md) — ファイル構成、移植と実通話で分かったこと、原価(10分で約$0.14)
- [未確認の点](docs/status.md) — 実通話・実機で確かめる必要が残っていること
- [Cloudflare 公開手順](docs/cloudflare-setup.md) / [構成](docs/cloudflare-architecture.md)

## 出典とライセンス

[heygen-com/liveavatar-gpt-live-demos](https://github.com/heygen-com/liveavatar-gpt-live-demos)
(MIT © 2026 HeyGen)を Gemini Live API に移植し、教える方向を逆にしたものです。
MIT。[LICENSE](LICENSE) を参照してください。
