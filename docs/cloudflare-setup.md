# Cloudflare への公開

Worker・D1・R2・Durable Objects で動かすための手順。1人が自分専用に公開する形を想定している。
Cloudflare Access でログインを1つのメールに絞り、Worker 側でも同じメールを照合する。
音声と採点は Gemini を使うので、AI の推論先は Google に残る。

Freeプランで始められる設定で、有料プランへの切り替え操作は含まない。

## 0. 用意するもの

- Cloudflare アカウントと、そこで管理しているドメイン(公開するホスト名を1つ決める)
- Cloudflare Zero Trust(Access)の有効化
- Gemini API キー — https://aistudio.google.com/apikey
- Node.js 22.16 以上

## 1. wrangler.jsonc の REPLACE_ME を埋める

`wrangler.jsonc` は雛形で、次の6か所が `REPLACE_ME` になっている。

| 場所 | 入れる値 | どこで分かるか |
| --- | --- | --- |
| `account_id` | Account ID(32桁の16進) | ダッシュボードのアカウント画面、または `npx wrangler whoami` |
| `routes[].pattern` | 公開するホスト名(例 `english.example.com`) | 自分で決める。Cloudflare で管理しているゾーンのもの |
| `vars.APP_ORIGIN` | 上と同じホスト名に `https://` を付けたもの | 同上。routes と食い違うと配信前に止まる |
| `vars.OWNER_EMAIL` | このアプリを使う本人のメール | Access のログインに使うメール |
| `vars.ACCESS_TEAM_DOMAIN` | `<チーム名>.cloudflareaccess.com` | Zero Trust → Settings → Custom Pages のチームドメイン |
| `vars.ACCESS_AUD` | Access アプリの Application Audience (AUD、64桁の16進) | 手順3で作るアプリの Overview |
| `d1_databases[].database_id` | D1 の UUID | 手順2の `wrangler d1 create` の出力 |

Worker 名・D1 名・R2 バケット名(`englishteacher`, `englishteacher-db`, `englishteacher-recordings`)は
そのままでも動く。変えるときは `wrangler.jsonc` だけ直せばよい。移行コマンドは設定から名前を読む。

自分の値を入れた `wrangler.jsonc` を fork にコミットしたくないなら、
`git update-index --skip-worktree wrangler.jsonc` で手元の変更を追跡から外す。

Gemini キーは設定ファイルに書かない。手元の `.env`(Node版とデプロイ時)と
Worker の secret(本番)に入れる。手順は下にある。

## 2. D1 と R2 を作る

リポジトリルートで実行する。

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create englishteacher-db --location apac --binding DB --update-config
npx wrangler r2 bucket create englishteacher-recordings --location apac --binding RECORDINGS --update-config
npx wrangler r2 bucket lifecycle add englishteacher-recordings recordings-14-days recordings/ --expire-days 14
```

`--update-config` を付けると、`wrangler.jsonc` の `DB` バインディングに実際の `database_id` が入る。
既に同名のDBがある場合は作り直さず、`npx wrangler d1 list --json` でIDを確認して設定する。
既存バケットや同名のライフサイクルルールも重複作成しない。
R2のbindingは `RECORDINGS` に統一する。CLIがバケット名由来の別bindingを追加した場合は、
未使用の重複bindingだけを設定から除く。R2の公開URL・公開カスタムドメインは有効にしない。

録音のR2キーは `recordings/`、画像は `images/` で分ける。
14日のライフサイクルは録音だけに適用する。
アプリは録音終了から14日で再生を拒否し、30分ごとの処理で削除する。
R2の経過日数ルールはアップロード時刻を基準とする予備の削除手段であり、アプリの期限判定とは別。

## 3. Access を設定する

Cloudflare Zero Trust で次を設定する。

- Self-hostedアプリ: 手順1で決めたホスト名の全体。パスを限定しない。
- Allowポリシー: Emailsで `OWNER_EMAIL` に書いたメールだけ。
- ログイン方法: One-time PIN(メールに届く数字。IdPを繋いでもよい)。
- チームドメインを `wrangler.jsonc` の `ACCESS_TEAM_DOMAIN` に設定する。`https://` や末尾の `/` は含めない。
- 同じアプリの Application Audience (AUD) を `ACCESS_AUD` に設定する。

Worker自身もJWT署名、発行元、AUD、有効期限、メールを検査する。
未設定時は拒否する。`workers.dev` とプレビューURLは無効。
HTML・静的ファイル・API・録音・WebSocketのすべてを認証対象にする。

## 4. ローカルで検証する

```sh
npm run typecheck
npm test
npm run cf:check
npm run cf:test
npm run cf:smoke
```

`cf:check` はインストール済みworkerdから型を生成する。
`cf:smoke` はデプロイ用バンドルをworkerdで起動し、認証拒否・保護された静的ファイル・教材読み込みを検査する。
どちらも待ち受けポートや外部APIへの通信を使わない。手順1の値を埋める前でも動く。
Geminiとの音声接続、実際のD1/R2、ブラウザ録音の検証は別途必要。

ローカルWorkersで画面とAPIを動かす場合(手順1の値を埋めてから):

```sh
cp .dev.vars.example .dev.vars
# .dev.varsに手元のGeminiキーを設定する。
npm run cf:migrate:local
npm run cf:dev
```

`cf:dev` の認証省略は `localhost` / `127.0.0.1` のみ。
この設定値を本番の `vars` に追加しない。
Cloudflareを使わないNode版は `npm run dev` / `npm start` で動く(`.env` にGeminiキーを入れるだけ)。

## 5. 公開する

対象ホスト名に既存の別サイトがないこととAccess設定を確認してから実行する。

```sh
cp .env.example .env     # GEMINI_API_KEY を設定する
npm run cf:deploy
```

このコマンドは設定検査、型検査、テスト、workerdでの起動検査、D1のリモートマイグレーション、
Workerの配信、Gemini secret登録を順に行う。
`REPLACE_ME` の残りや、不足したAccess設定・D1 ID・APP_ORIGINとroutesの食い違いがあれば、
外部への変更前に名前を挙げて停止する。
Geminiキーはルートの `.env` または実行環境の `GEMINI_API_KEY` から読み、Wranglerの標準入力にだけ渡す。
キーの値を設定ファイルやコマンド引数へ書き込まない。
初回配信からsecret登録までの間、会話開始APIは設定不足として拒否する。

事前検査だけなら以下を使う。

```sh
node scripts/cloudflare-deploy.mjs --check
```

### main への push で自動配信する

`.github/workflows/deploy.yml` が、`main` への push と手動実行(Actions画面のRun workflow)で
同じ配信を行う。中身は `node scripts/cloudflare-deploy.mjs --ci` で、手元と同じ検査
(型検査・テスト・workerd起動検査)を通してからD1のリモート移行とWorkerの配信を行う。
`--ci` はGemini secretを登録しない。登録済みのsecretはデプロイをまたいで残るため、
キーを変えるときだけ手元から `npm run cf:deploy` を実行する。

使うなら2つ用意する。

1. `wrangler.jsonc` に自分の値が入った状態でコミットされていること
   (CIはリポジトリの内容をそのまま読む。`skip-worktree` にしていると値が届かない)。
2. リポジトリのSecretに `CLOUDFLARE_API_TOKEN` を入れること。
   Cloudflareダッシュボード → My Profile → API Tokens → Create Token。
   テンプレート「Edit Cloudflare Workers」を選び、対象アカウントに絞る。
   D1のリモート移行を通すため、権限に Account → D1 → Edit を追加する。
   ```sh
   gh secret set CLOUDFLARE_API_TOKEN   # 値は対話入力。コマンド履歴に残さない
   ```

Secretが無いまま`main`にpushすると、最初のステップで理由を出して落ちる(配信はしない)。
`--ci` はGitHub Actionsが注入する `GITHUB_ACTIONS` の存在を要求するので、手元で
うっかり `--ci` を付けても本番には届かない。

自分で配信しないなら、このワークフローは削除してよい。

## 6. ローカルの復習データを移す

Node版で練習した記録がある場合だけ。

```sh
npm run cf:export
```

`data/results/*.jsonl` の採点・訂正・復習結果を、Git管理外の `data/cloudflare-import.json` へ書き出す。
公開先に本人としてログインし、「履歴」→「以前の復習を取り込む」でこのファイルを選ぶ。
1件ずつ保存し、途中で失敗しても同じファイルから再実行できる。同じイベントは二重に反映しない。
取り込み後は「今日の復習」に予定を反映する。

この取り込みは復習結果の移行。旧JSONLにない会話全文・モデルのスクリプト・録音は復元できない。
新しいクラウドセッションからは双方の確定スクリプトとノートを履歴に保存する。

## 7. 公開後に確認すること

1. 未ログインではAccessのログイン画面になり、許可メール以外では入れない。
2. 短い会話を終了し、ページを再読み込みしても自分・モデルのスクリプトとノートが読める。
3. シーン、瞬間英作文、話し直し、今日の復習の各モードで音声と採点が動く。
4. ボードで描いた板が先生に届く(挨拶のあとで板の中身に触れる)。iPadのペンと指でも描ける。
5. 回線切断から60秒以内の再接続で、確定した復習結果が二重に記録されない。
6. 履歴から圧縮録音を再生できる。Safari/iPhoneでもマイク許可・再生・録音を実機確認する。
7. R2削除処理に失敗したときは容量を解放せず、次の実行で再試行する。

録音はブラウザのMediaRecorderで64kbpsを指定し、対応するWebM/Opus・MP4・Oggのいずれかを使う。
通常の終了操作の後にアップロードする。タブ強制終了やOSによる停止では録音を保存できない場合がある。
スクリプトとノートは会話中にサーバー側で保存する。
音声容量は既定8GBの予算に対して80%で新規保存を止め、70%未満で再開する。
1セッション最大32MBの予約も含めて計算し、録音が保存されない場合も復習データは残す。

## 現在の制約

- 実装は1人用。`OWNER_EMAIL` は1つだけで、アカウント別の履歴や複数人の同時利用はない。
  他の人に使わせるなら、Accessのポリシーを広げるだけでは足りず `OWNER_EMAIL` 側の作りを変えることになる。
- 実際のGemini音声接続・保存・iPhone/iPadの実機確認は、この手順を通したあと自分の環境で行う必要がある。
- iPhone向けネイティブアプリ、PWA、パスキー認証は含まない。初期版はAccessでログインするWeb。
- 終了後の追加要約用Queuesは未導入。現在の指導・採点と、Durable Objectの未反映イベント＋alarmによる再試行を使う。
- オブジェクトの再生成時は進行状態から新しいGemini接続を開始する。
  分析中に失われた未採点音声は、もう一度話してもらう。
