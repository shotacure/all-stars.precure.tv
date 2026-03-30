# プリキュアオールスターズいえるかなクイズ

プリキュアオールスターズに関するクイズアプリケーションです。  
多言語対応（日本語・英語）で、オンラインランキング機能を備えています。

## ディレクトリ構成

```
├── site/                         # フロントエンド（S3 + CloudFront で配信）
│   ├── index.html
│   ├── error.html
│   ├── config.js.example         # フロントエンド設定サンプル
│   ├── assets/
│   │   ├── css/style.css
│   │   ├── js/script.js
│   │   └── images/
│   └── data/
│       ├── precure.json          # クイズデータ
│       └── i18n/
│           ├── ja.json           # 日本語
│           └── en.json           # 英語
│
├── lambda/                       # バックエンド（AWS Lambda / Node.js 22.x）
│   ├── session/
│   │   ├── index.mjs             # セッショントークン発行
│   │   └── package.json
│   └── score/
│       ├── index.mjs             # スコア送信・ランキング更新
│       └── package.json
│
├── template.yaml                 # SAM テンプレート（インフラ定義）
├── samconfig.toml.example        # SAM 設定サンプル
├── deploy.sh.example             # デプロイスクリプトサンプル（bash）
├── deploy.ps1.example            # デプロイスクリプトサンプル（PowerShell）
├── .gitignore
├── LICENSE
├── VERSION
└── README.md
```

## アーキテクチャ

```
                          ┌─────────────────────┐
                          │     CloudFront       │
                          │  (CDN / キャッシュ)   │
                          └──────┬──────────┬────┘
                                 │          │
                    静的ファイル  │          │  /api/*
                                 │          │
                          ┌──────▼───┐  ┌───▼──────────┐
                          │  S3      │  │ API Gateway   │
                          │ (site/)  │  │ (HTTP API)    │
                          └──────────┘  └───┬───────┬───┘
                                            │       │
                                GET /api/   │       │  POST /api/
                                session     │       │  score
                                       ┌────▼──┐ ┌──▼─────┐
                                       │Lambda │ │Lambda  │
                                       │Session│ │Score   │
                                       └───────┘ └──┬──┬──┘
                                                     │  │
                                              ┌──────▼┐ │
                                              │DynamoDB│ │  leaderboard.json
                                              │(top20) │ │  を S3 に書き出し
                                              └────────┘ │
                                                   ┌─────▼────┐
                                                   │  S3      │
                                                   │(JSON更新) │
                                                   └──────────┘
```

### ランキングシステムの仕組み

ランキングはバックエンドへのアクセスを最小限に抑える設計になっています。

**読み取り（大量・低コスト）**

`leaderboard.json` は S3 上の静的ファイルとして CloudFront 経由で配信されます。ブラウザはページ読み込み時にこの JSON を取得し、メモリ上に保持します。バックエンドへの API 呼び出しは発生しません。

**書き込み（最小限）**

バックエンドへのアクセスが発生するのは以下の 2 つのタイミングのみです。

1. **クイズ開始時** — `GET /api/session` でセッショントークンを取得
2. **ランクイン時のみ** — `POST /api/score` でスコアを送信（圏外なら API 呼び出しなし）

### セキュリティ対策

**セッショントークンによるタイム偽装防止**

クイズ開始時に HMAC-SHA256 署名付きトークンが発行されます。スコア送信時にサーバー側でトークンの発行時刻と申告タイムの整合性を検証し、実経過時間より速いタイムの申告を拒否します。署名の比較にはタイミングセーフな手法を使用し、サイドチャネル攻撃を防止しています。

**ワンタイムトークン（リプレイ攻撃防止）**

各トークンは一度しか使用できません。使用済みの nonce を DynamoDB に記録し、同じトークンによる再送信を拒否します。記録は TTL（20分）で自動削除されるため、テーブルが肥大化することはありません。

**トークン有効期限**

トークンの有効期限は発行から 10 分に制限されています。クイズの所要時間（最大 655 秒 ≒ 約 11 分）を考慮した設定で、長時間放置されたトークンの悪用を防ぎます。

**結果バイナリの整合性検証**

クライアント側で生成される結果バイナリ（各問の回答時間・正誤）をサーバー側でデコードし、申告された正解数・合計タイムとの一致を検証します。正解数は 0〜10 の範囲、合計タイムは正の値かつ上限以内であることも検証します。

**Lambda 同時実行数制限**

スコア送信用の Lambda 関数は `ReservedConcurrentExecutions: 2` に設定されており、同時実行数が最大 2 に制限されています。ハイスコア送信は稀な操作のため、これにより大量リクエストによる攻撃を抑止します。

**入力サニタイズ**

名前は Unicode 文字数で 16 文字以内に制限され、制御文字や HTML タグは除去されます。

**楽観的ロック**

DynamoDB への書き込みには条件付き書き込み（楽観的ロック）を使用し、同時更新によるデータ競合を防止します。

### 順位ロジック

ランキングへの登録は満点（10問全問正解）のみが対象です。満点達成者の中で合計タイムの昇順（速い方が上位）で順位を決定します。上位 20 位以内に入った場合のみ名前の入力を受け付けます。

## セットアップ

### 前提条件

以下のツールをインストールしてください。

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS アカウント（IAM ユーザーのアクセスキー設定済み）

```bash
# インストール確認
aws --version
sam --version
```

### 1. AWS CLI の認証設定

```bash
aws configure
```

リージョンは `ap-northeast-1`（東京）を推奨します。

### 2. IAM ポリシーの設定

デプロイ用の IAM ユーザーに以下のポリシーをアタッチしてください。  
`YOUR_ACCOUNT_ID` / `YOUR_SITE_BUCKET` / `YOUR_DISTRIBUTION_ID` を実際の値に置き換えます。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet"
      ],
      "Resource": [
        "arn:aws:cloudformation:ap-northeast-1:YOUR_ACCOUNT_ID:stack/allstars-*",
        "arn:aws:cloudformation:ap-northeast-1:YOUR_ACCOUNT_ID:stack/aws-sam-cli-managed-default/*",
        "arn:aws:cloudformation:ap-northeast-1:aws:transform/Serverless-2016-10-31"
      ]
    },
    {
      "Sid": "LambdaFunctions",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListTags",
        "lambda:TagResource",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency"
      ],
      "Resource": "arn:aws:lambda:ap-northeast-1:YOUR_ACCOUNT_ID:function:allstars-*"
    },
    {
      "Sid": "ApiGateway",
      "Effect": "Allow",
      "Action": "apigateway:*",
      "Resource": "arn:aws:apigateway:ap-northeast-1::/*"
    },
    {
      "Sid": "DynamoDB",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:UpdateTable",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:DescribeTimeToLive"
      ],
      "Resource": "arn:aws:dynamodb:ap-northeast-1:YOUR_ACCOUNT_ID:table/allstars-*"
    },
    {
      "Sid": "IAMRolesForLambda",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PassRole",
        "iam:TagRole"
      ],
      "Resource": "arn:aws:iam::YOUR_ACCOUNT_ID:role/allstars-*"
    },
    {
      "Sid": "S3SiteDeployment",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR_SITE_BUCKET",
        "arn:aws:s3:::YOUR_SITE_BUCKET/*"
      ]
    },
    {
      "Sid": "S3SamArtifacts",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:CreateBucket"
      ],
      "Resource": [
        "arn:aws:s3:::aws-sam-cli-managed-default-*",
        "arn:aws:s3:::aws-sam-cli-managed-default-*/*"
      ]
    },
    {
      "Sid": "CloudFrontInvalidation",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
    }
  ]
}
```

### 3. SAM 設定ファイルの作成

```bash
cp samconfig.toml.example samconfig.toml
```

`samconfig.toml` を開き、以下のパラメータを設定します。

- `SiteBucketName` — S3 バケット名
- `SessionSecret` — セッショントークンの署名鍵（32 文字以上のランダム文字列）
- `CorsOrigin` — 許可する CORS オリジン（例: `https://your-domain.example.com`）

署名鍵の生成例:

```bash
openssl rand -hex 32
```

### 4. デプロイスクリプトの作成

**macOS / Linux:**

```bash
cp deploy.sh.example deploy.sh
chmod +x deploy.sh
```

**Windows (PowerShell):**

```powershell
Copy-Item deploy.ps1.example deploy.ps1
```

スクリプトを開き、`SITE_BUCKET` と `CF_DISTRIBUTION_ID` を設定します。

### 5. フロントエンド設定ファイルの作成

```bash
cp site/config.js.example site/config.js
```

`site/config.js` の `API_BASE_URL` は、初回バックエンドデプロイ後に設定します（後述）。  
`config.js` が存在しない、または `API_BASE_URL` が空の場合でもクイズ本体は動作します（ランキング機能のみ無効）。

## デプロイ

以下は bash の例です。PowerShell の場合は `./deploy.sh` を `.\deploy.ps1` に、引数を `-Target` パラメータに読み替えてください（例: `.\deploy.ps1 -Target backend`）。

### 初回デプロイ

```bash
# 1. バックエンドをデプロイ
./deploy.sh backend
```

初回の `sam deploy` では CloudFormation のチェンジセット確認が表示されます。内容を確認して `y` で進めてください。

```bash
# 2. API エンドポイントを確認
aws cloudformation describe-stacks \
  --stack-name allstars-backend \
  --query "Stacks[0].Outputs" \
  --output table

# 3. site/config.js に API エンドポイントを設定
#    API_BASE_URL: 'https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/prod'

# 4. ランキングJSON を初期化
echo '{"updatedAt":"","top20":[]}' | aws s3 cp - s3://YOUR_SITE_BUCKET/leaderboard.json \
  --content-type "application/json" \
  --cache-control "public, max-age=30"

# 5. フロントエンドをデプロイ
./deploy.sh site
```

### フロントエンドのみ更新

```bash
./deploy.sh site
```

### バックエンドのみ更新

```bash
./deploy.sh backend
```

### 全体を更新

```bash
./deploy.sh
```

## ローカル開発

### フロントエンド

`site/` ディレクトリをローカル HTTP サーバーで配信します。

```bash
# Python 3 の場合
cd site && python3 -m http.server 8000

# Node.js の場合
npx serve site
```

ブラウザで `http://localhost:8000` を開きます。

### バックエンド

SAM CLI でローカルの API を起動できます。

```bash
sam build
sam local start-api
```

`http://localhost:3000/api/session` などでローカルテストが可能です。  
ただし DynamoDB のローカルエミュレーションには [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html) が別途必要です。

## コスト目安

個人ファンサイト規模（月間数百〜数千アクセス）であれば、ほぼ無料枠内で運用できます。

| サービス | 無料枠 | 想定コスト |
|---|---|---|
| Lambda | 月 100 万リクエスト | 無料 |
| DynamoDB | 25GB + 月 2500 万リクエスト | 無料 |
| API Gateway (HTTP API) | 月 100 万リクエスト（12 か月間） | 無料〜$0.01 |
| S3 | 5GB + 月 2 万リクエスト | 既存分のみ |
| CloudFront | 月 1TB + 1000 万リクエスト | 既存分のみ |

## 環境別設定ファイル

以下のファイルは環境固有の値を含むため `.gitignore` で除外されています。  
`.example` ファイルをコピーして実際の値を設定してください。

| サンプル | コピー先 | 用途 |
|---|---|---|
| `samconfig.toml.example` | `samconfig.toml` | SAM デプロイ設定（スタック名、パラメータ） |
| `deploy.sh.example` | `deploy.sh` | デプロイスクリプト bash（バケット名、Distribution ID） |
| `deploy.ps1.example` | `deploy.ps1` | デプロイスクリプト PowerShell（同上） |
| `site/config.js.example` | `site/config.js` | フロントエンド設定（下表参照） |

### site/config.js の設定項目

| キー | 説明 | 例 |
|---|---|---|
| `API_BASE_URL` | バックエンド API エンドポイント | `https://xxxxx.execute-api.ap-northeast-1.amazonaws.com/prod` |
| `GA4_MEASUREMENT_ID` | Google Analytics 4 測定 ID | `G-XXXXXXXXXX` |

いずれも空文字の場合、対応する機能（ランキング / アクセス解析）が無効になるだけでクイズ本体は正常に動作します。

## License

[LICENSE](./LICENSE) を参照してください。
