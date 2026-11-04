# LUX NEXT

ロキ様のためのAI相棒。React / TypeScript / Vite + GitHub Pages の静的PWAです。既存の `lux-app` と独立しています。

## 状態（2026-11-05）

- 実装: 会話UI、ローカル履歴、明示的な記憶の追加・編集・削除・検索、JSONエクスポート・初期化、Web Speech音声入力・読み上げ、画面が開いている間の予定・毎日/毎週の繰り返し・タイマー・通知履歴、PWAマニフェスト・Service Worker。
- 実装・単体テスト済み、未デプロイ: Cloudflare Worker + SQLite Durable Objectによる認証、入力検証、サーバー側予算制限、6回/分の制限、503の最大3試行、429の停止、タイムアウト、Gemini接続処理。
- 未検証: 実Gemini応答、Cloudflare実環境、iPhoneの音声認識・音声再生・ホーム画面インストール・オフライン挙動。
- 未実装: 閉じた状態でのWeb Push、サーバースケジューラー、会話からの予定自動登録、ハンズフリー・割り込み、クラウド同期、ローカル暗号化、課金、アカウント登録。

AI未接続時に架空のAI回答は表示しません。設定が必要であることを表示します。

## 開発 / 公開

Node.js 22.12以上。`npm install` → `npm test` → `npm run build`。GitHub Actionsは `main` へのpush後に検証・ビルドし、`dist` のみをPagesへ公開します。ソースやWorker設定はPagesの配信ファイルに含めません。

GitHub Settings → Pages → Sourceを **GitHub Actions** に設定。ベースURLは `/lux-next/` です。アプリの名前を変える場合はVite、マニフェスト、SWのscopeを揃えて変更してください。

## バックエンドの選定

| 候補 | 無料枠（確認日現在） | 秘密の管理 | iPhoneでの管理 / 判断 |
| --- | --- | --- | --- |
| Cloudflare Workers + SQLite Durable Objects | Worker 10万リクエスト/日、DOにも無料枠 | Worker Secrets | ダッシュボードとGitHub連携。予算台帳を強整合で保持できるため採用 |
| Supabase Edge Functions | 50万呼び出し/月 | Function Secrets | Auth/DBを一体化できるが、今回の一人用構成では設定が増える。クラウド同期時の候補 |

Workers FreeはCPU時間等の制限があります。有料契約は行っていません。無料サービスの提供や容量・AI応答の安定性は保証されません。

## 安全なAI接続（設定が必要）

1. Cloudflareへログインし、Workers & PagesでGitHubのこのリポジトリを接続。Workerとして `wrangler.jsonc` を使用し、ビルド不要、デプロイコマンド `npx wrangler deploy` で配置します。ローカルなら同じコマンドを利用できます。
2. Workerの設定に、以下を **Secret** として追加します。GitHub・このREADME・ChatGPTの本文には貼り付けないでください。
   - `GEMINI_API_KEY`: Google AI Studioで作成したAPIキー。
   - `ACCESS_TOKEN`: パスワードマネージャー等で生成した32文字以上のランダムな専用コード。Gemini APIキーとは別物です。
3. `BUDGET` のDurable ObjectバインドとSQLite migrationが適用されていることを確認。未設定ではリクエストを拒否します。
4. アプリ「設定」にWorker URLと **専用アクセスコード** を入力し、「接続を確認」。コードはブラウザのメモリ上だけに保持し、閉じると消えます。APIキーは入力しません。
5. 少量の実リクエストでモデル利用権限・API無料枠・単価をGoogle AI Studioで確認。

### 予算とモデル

初期モデル `gemini-3.5-flash-lite`。公式単価は100万トークンあたり入力$0.30、出力$2.50（2026-11-05確認）。無料枠の実際の上限はプロジェクトごとにAI Studioで確認してください。無料枠では入力がサービス改善に使われる場合があります。

Workerの `MONTHLY_BUDGET_YEN` は初期1000、最大2000。`USD_JPY` は概算用の設定値150で、現在為替を示すものではありません。請求通貨・税・為替差・単価改定を含む実際の支払額の保証ではありません。

予算判定はブラウザ値を信用せず、DOに保持したJST月別予約台帳で行います。最大3試行分のトークン上界見積もり（入力UTF-8バイト数+余裕、出力2048）を送信前に予約し、失敗しても解放しません。実利用の概算と予約額を分けて表示します。安全側なので実費より早く上限に達します。キーをこのWorker以外で使った料金は制御できません。単価変更時には `price()` を更新してください。現在は初期モデルだけを許可し、高額モデルへの任意変更を拒否します。将来のモデル追加は検証・単価追加を伴うサーバー変更で行います。

サーバーは会話本文や記憶を永続保存せず、本文ログ出力も行いません。Cloudflare/Googleのサービス側の処理・保持は各社の規約に従います。トークン認証は一人用であり、将来の一般提供前にはユーザー認証・ユーザー別台帳・データ分離への変更が必要です。

## データと音声の注意点

- 保存はブラウザlocalStorage。暗号化ではなく、端末の共有や同一originの別アプリからのアクセスにも注意が必要です。GitHub Pagesでは同じ `loxoninloki.github.io` の他のページとoriginを共有します。他人が別端末から同じURLを開いても、この端末の会話は取得できません。
- 記憶の保存は本人による手動操作のみ。機微情報を自動抽出しません。Gemini送信時は直近16メッセージと登録記憶を文脈に使用します。
- エクスポートは平文JSONなので安全に保管してください。Safariのサイトデータ削除や容量整理で保存内容を失うことがあります。
- 音声認識は端末/ブラウザが提供し、提供元へ音声が送られる場合があります。声の性別・品質や自動再生は端末依存です。読み上げボタンと停止ボタンを用意しています。
- オーブの音声連動は認識中/読み上げ中の**状態**への連動です。マイク音量に比例する可視化ではありません。
- iOS 16.4以降ではホーム画面に追加したWebアプリでWeb Pushが使えますが、本人操作による許可、Push購読、サーバー側配送・スケジューラーが必要です。この版はWeb Pushを実装していません。タイマーは画面を開いている間に確認し、バックグラウンドの正確な時刻を保証しません。

## 公式資料

- [Geminiモデル](https://ai.google.dev/gemini-api/docs/models)
- [Gemini料金](https://ai.google.dev/gemini-api/docs/pricing)
- [Geminiレート制限](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini GenerateContent](https://ai.google.dev/api/generate-content)
- [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Durable Objects Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Supabase Functions料金](https://supabase.com/docs/guides/functions/pricing)
- [iOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## バックアップ

新規プロジェクトのため既存アプリは変更しません。Gitのコミット履歴がソースの復元地点です。ユーザーデータはコードのGitバックアップには含まれず、アプリから別途エクスポートしてください。
