# AI 解答システム

スマートフォンのカメラで問題用紙を撮影し、Gemini が解いた**答えだけ**を別デバイスの画面に
大きく表示するシステム。撮影は一定間隔（既定20秒）で自動的に繰り返される。

**解説・問題文は表示しない。** 選択肢問題は「正解が上から何番目か」の数字のみを返す。
画面を離れた場所から見る用途を想定しているため、答えの文字サイズを 2〜12rem で変更できる。

## 構成

```
ai-answer-system/
├── server.js          # Express + Socket.io バックエンド + Gemini 呼び出し
├── public/
│   ├── display.html   # 閲覧側（モニター・タブレット）。答えを大きく表示
│   └── camera.html    # 撮影側（スマートフォン）。一定間隔で自動撮影
├── .env.example       # 環境変数テンプレート
├── render.yaml        # ⚠️ 旧 Render 用。現在は使っていない（本番はさくらVPS）
└── package.json
```

**データベースは無い。** ルーム情報はすべてサーバーのメモリ上（`Map`）にあり、
プロセスを再起動すると消える（閲覧側が再接続すれば同じIDで作り直される）。

画面は素の HTML + JavaScript。Tailwind CSS と qrcode.js を**外部CDNから読み込んでいる**ため、
CDN に到達できない環境では見た目が崩れ、QRコードが表示されない。

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

1. **閲覧側**（PC・タブレット）でブラウザを開く
   - 本番: `https://rurucoa.com/aas/`（`/aas/display.html` へ自動転送。Basic認証あり）
   - ローカル: `http://localhost:3001/display.html`
2. 画面に Room ID と QR コードが表示される
3. **スマホ側**でQRコードをスキャン（または `.../camera.html?room=[ID]` に直接アクセス）
4. カメラが起動したら問題用紙をかざす
5. **20秒ごとに自動で撮影・送信**され、閲覧側に答えが表示される
   - 次の撮影までの残り時間はプログレスリングで表示される

## 動作の仕組み

```
スマホ（camera.html）
  └─ CAPTURE_INTERVAL_MS（20秒）ごとに1枚キャプチャ
  └─ 最大辺 1280px に縮小 → JPEG 品質 0.75 で base64 化 → Socket.io で送信

バックエンド（server.js）
  └─ ルームごとにレート制限（RATE_LIMIT_SECONDS = 10秒に1回。処理中の重複も拒否）
  └─ Gemini に「画像 + 指示文」を渡し、プレーンテキストで答えを受け取る
  └─ 429（API上限）なら待機時間を解析して 1回だけ自動リトライ
  └─ 結果を Socket.io でルーム全員にブロードキャスト

閲覧側（display.html）
  └─ 答えを1つ大きく表示（2〜12rem。localStorage に保存され次回も維持）
  └─ 直近5件の答えを履歴として下部に表示
```

### Gemini への指示内容（プロンプト）

`server.js` の `analyzeImage()` に直接書かれている。要点は4つ。

| 入力 | 出力 |
|---|---|
| 選択肢あり（①②③④ / ア〜エ / A〜D / 1〜4） | **正解が上から何番目かの数字のみ**（例: `3`） |
| 選択肢なし | 答えだけを簡潔に |
| 問題が読み取れない | `読み取り不可` |
| — | **解説・問題文は出力しない** |

`読み取り不可` はサーバー側でエラー扱いにし、`unreadable` フラグを付けてカメラへ返す。
カメラ側はこれを受けてクールタイムを **5秒**（通常のエラーは10秒）に短縮し、素早く再試行する。

### ルームの寿命

| 出来事 | 挙動 |
|---|---|
| 閲覧側が `create_room` | 10文字の Room ID を発行（`0/O/1/I` 等を除いた32文字から生成） |
| 有効期限（既定60分）超過 | 1分ごとの点検で削除し、参加者に `room_expired` を通知 |
| **閲覧側**が切断 | ルームを即削除（撮影側も切り離される） |
| **撮影側**が切断 | ルームは維持。閲覧側に `camera_disconnected` を通知 |
| サーバー再起動後に閲覧側が復帰 | `rejoin_room` で**同じIDのまま**作り直す |

### 設定値のありか（★ 注意）

**撮影間隔だけは環境変数ではなく、`public/camera.html` の先頭に定数として書かれている。**

```javascript
const CAPTURE_INTERVAL_MS = 20_000;  // 20秒ごとに送信
const SEND_MAX_SIDE       = 1280;    // 送信画像の最大辺
const SEND_QUALITY        = 0.75;    // JPEG圧縮品質
```

`.env` を探しても見つからないので注意。変更したらデプロイし直す必要がある。

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
