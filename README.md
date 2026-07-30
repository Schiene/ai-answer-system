# AI 解答システム

iPhone等のカメラデバイスで問題用紙を撮影し、問題の変更を自動検知して別デバイスの画面にAIによる解答と解説をリアルタイムに表示するシステム。

## 構成

```
ai-answer-system/
├── server.js          # Express + Socket.io バックエンド
├── public/
│   ├── display.html   # 閲覧側（モニター・タブレット）
│   └── camera.html    # 撮影側（スマートフォン）
├── .env.example       # 環境変数テンプレート
└── package.json
```

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して `GEMINI_API_KEY` に Gemini API キーを設定します。

### 3. HTTPS の設定（別デバイスからカメラを使う場合は必須）

`getUserMedia` は HTTPS または localhost でしか動作しません。LAN 内の別デバイスからアクセスする場合は mkcert でローカル証明書を発行するか、ngrok を使用してください。

**mkcert を使う場合:**
```bash
mkcert -install
mkcert localhost 192.168.x.x  # サーバーのIPアドレスを指定
```

生成された証明書のパスを `.env` に設定します:
```
SSL_CERT_PATH=./localhost+1.pem
SSL_KEY_PATH=./localhost+1-key.pem
```

### 4. 起動

```bash
# 開発用（ファイル変更で自動再起動）
npm run dev

# 本番
npm start
```

## 使い方

1. **モニター側** でブラウザを開き `https://[サーバーIP]:3001/display.html` にアクセス
2. 画面に Room ID と QR コードが表示される
3. **スマホ側** でQRコードをスキャン（または `https://[サーバーIP]:3001/camera.html?room=[ID]` に直接アクセス）
4. カメラが起動したら問題用紙をかざす
5. 紙が静止したことを検知すると自動的にAIへ送信し、モニター側に解答が表示される

## 動作の仕組み

```
スマホ（Camera Client）
  └─ 2枚のキャンバスで処理
       ├─ diffCanvas (320×240): 差分検知専用（軽量）
       └─ sendCanvas (最大1280px): 送信用（高画質）
  └─ STABLE_FRAME_COUNT 回連続して差分が閾値以下 → 画像を送信

バックエンド（server.js）
  └─ ルームごとにレート制限（10秒に1回）
  └─ Gemini API（responseMimeType: application/json + responseSchema）
  └─ 結果を Socket.io で Display へブロードキャスト

モニター（Display Client）
  └─ 問題文・解説・答えを表示
  └─ 最新5件の解答履歴タブ
```

## 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `GEMINI_API_KEY` | — | Gemini API キー（必須） |
| `GEMINI_MODEL` | `gemini-3.6-flash` | 使用するモデル。**画像入力に対応したものを選ぶこと** |
| `PORT` | `3001` | サーバーポート |
| `BASE_PATH` | （空） | 配信サブディレクトリ。本番は `/aas`。未設定ならルート直下 |
| `ROOM_ID_LENGTH` | `10` | Room ID の桁数 |
| `ROOM_EXPIRY_MINUTES` | `60` | ルーム有効期限（分） |
| `RATE_LIMIT_SECONDS` | `10` | 送信間隔の最低秒数 |
| `SSL_CERT_PATH` | — | SSL 証明書パス |
| `SSL_KEY_PATH` | — | SSL 秘密鍵パス |

## 本番デプロイ（さくらVPS）

公開 URL: **`https://rurucoa.com/aas/`**（入口は `/aas/` → `/aas/display.html` へ自動転送）

**Basic 認証で保護されており、本人以外はアクセスできません。**
ユーザー名は `saku`、パスワードは `/etc/nginx/.htpasswd-aas`（パスワード管理アプリに保管）。

| 項目 | 場所 |
|---|---|
| 本番コード | `/opt/ai-answer-system`（`aas` ユーザー所有。git 管理外） |
| 設定・秘密 | `/etc/ai-answer-system/aas.env`（640 root:aas） |
| サービス | `ai-answer-system.service`（`127.0.0.1:3001` で待ち受け） |
| Nginx | `/etc/nginx/sites-available/rurucoa.com` の `location ^~ /aas/` |
| 認証情報 | `/etc/nginx/.htpasswd-aas`（640 root:www-data） |

### サブディレクトリ配信の仕組み（重要）

このアプリは `/aas/` という**サブパス配下**で動く。関係する箇所は3つで、**すべて揃っていないと動かない**。

1. **サーバー**: `BASE_PATH=/aas` を渡す。`express.static` と `/health` と Socket.io の
   受付パスが `/aas` 配下にずれる
2. **ブラウザ**: `public/*.html` は `socket.io/socket.io.js` を**相対パス**で読み、
   `io({ path: new URL('socket.io', location.href).pathname })` で接続先を組み立てる。
   QRコードのカメラURLも `new URL('camera.html?...', location.href)` で組む。
   → 先頭に `/` を付けると `/aas/` が抜けて壊れる
3. **Nginx**: `proxy_pass http://127.0.0.1:3001;` の**末尾にスラッシュを付けない**。
   付けると `/aas/` が削られて渡り、1 の設定と食い違って Socket.io が繋がらない

WebSocket を通すため、`map $http_upgrade $connection_upgrade` と
`proxy_set_header Upgrade / Connection` が必要（`rurucoa.com` の設定ファイルに記載済み）。

### デプロイ手順

```bash
ssh aukss
cd ~/source/ai-answer-system && git pull
sudo rsync -a --delete --exclude node_modules --exclude .git --exclude .env \
  ~/source/ai-answer-system/ /opt/ai-answer-system/
cd /opt/ai-answer-system && sudo npm ci --omit=dev
sudo chown -R aas:aas /opt/ai-answer-system
sudo systemctl restart ai-answer-system
systemctl status ai-answer-system --no-pager
```

### 動作確認

```bash
curl -u saku:<パスワード> https://rurucoa.com/aas/health
# {"status":"ok","rooms":0,...} が返れば正常
```

> HTTPS は nginx（Let's Encrypt）と Cloudflare が担うため、`SSL_CERT_PATH` /
> `SSL_KEY_PATH` は本番では設定不要（ローカル開発でカメラを使うときだけ必要）。
