# cf-build-notify

Cloudflare Workers Builds の結果を Slack に通知する Worker です。Queue `builds-event-subscriptions` の consumer で、[公式の通知テンプレート](https://github.com/cloudflare/templates/tree/main/workers-builds-notifications-template)を基にしています。イベントの形は [Events & schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/) の Workers Builds に合わせています。

## 送るもの

対応表にある Worker の **本番ビルドの成功**（`cf.workersBuilds.worker.build.succeeded`）と **失敗**（`cf.workersBuilds.worker.build.failed`）だけです。

次は ack して捨てます。

- 開始（`build.started`）
- キャンセル（`build.canceled`、または `buildOutcome` が `canceled` / `cancelled`）
- プレビュー（本番ブランチ以外）
- 対応表に無い Worker

## 本番の判定

公式スキーマに `environment` や `isPreview` はありません。Workers Builds は [本番ブランチへの push を本番ビルド、それ以外をプレビュー](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)にします。イベントに載るのは `payload.buildTriggerMetadata.branch` だけです。

公式テンプレートと同じく、ブランチ名が次のいずれか（大文字小文字は区別しない）のときだけ本番とみなします。

- `main`
- `master`
- `production`
- `prod`

ブランチが無いイベントは本番だと確認できないので捨てます。本番ブランチをこれ以外の名前にしている Worker は、`src/routing.ts` の `PRODUCTION_BRANCHES` にその名前を足すまで通知されません。

## チャネルの振り分け

`source.workerName`（wrangler の `name`）で Secret を選びます。

| Worker 名 | Secret |
| --- | --- |
| `aiken-oyatsu-lp` | `SLACK_WEBHOOK_AIKEN_OYATSU_LP` |

[aiken-oyatsu-lp](https://github.com/k-yoshi1126/aiken-oyatsu-lp) は非公開で、この作業環境の GitHub 権限では wrangler の `name` を読めませんでした。指定の `aiken-oyatsu-lp` をそのまま使っています。実際の `name` が違う場合は、上の表と `src/routing.ts` のキーを wrangler の `name` に合わせてください。購読の `--worker-name` も同じ名前です。

## Secrets

コードにも wrangler の `vars` にも値は書きません。

| 名前 | 用途 |
| --- | --- |
| `SLACK_WEBHOOK_AIKEN_OYATSU_LP` | `#build-aiken-oyatsu-lp` の Incoming Webhook URL |
| `CLOUDFLARE_API_TOKEN` | 成功時の workers.dev URL と、失敗時のビルドログ取得 |

テンプレートはプレビュー URL・ライブ URL・失敗ログのために API トークンを使います。この Worker も成功時の workers.dev URL（`Workers Scripts: Read`）と失敗ログ（`Workers Builds Configuration: Read`）に使うので、トークンは残しています。トークンが空でも通知自体は送ります。その場合、成功時のボタンはダッシュボードのビルド、失敗時の本文は「ログを取得できませんでした」になります。

トークンはユーザー向けのものを使ってください。アカウント所有トークンは Builds API で Invalid token になります。

## 開発

```bash
npm ci
npm test
npm run typecheck
```

テストは振り分けと絞り込み、および Queue handler が捨てるイベントで Webhook を呼ばないことを見ます。GitHub Actions の CI でも同じコマンドを回します。

ローカルの値は `.dev.vars.example` を `.dev.vars` にコピーして入れます。`.dev.vars` はコミットしません。

`wrangler.jsonc` の `secrets.required` は、この2つの Secret を型に出すための宣言です。Worker がまだ無い状態では `wrangler secret put` が使えないので、初回は `npx wrangler deploy --secrets-file .dev.vars` でコードと Secret を同時に載せます。2回目以降の deploy は、既に入っている Secret を引き継ぎます。
