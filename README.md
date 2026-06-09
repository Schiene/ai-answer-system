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
| `GEMINI_MODEL` | `gemini-2.0-flash` | 使用するモデル |
| `PORT` | `3001` | サーバーポート |
| `ROOM_ID_LENGTH` | `10` | Room ID の桁数 |
| `ROOM_EXPIRY_MINUTES` | `60` | ルーム有効期限（分） |
| `RATE_LIMIT_SECONDS` | `10` | 送信間隔の最低秒数 |
| `SSL_CERT_PATH` | — | SSL 証明書パス |
| `SSL_KEY_PATH` | — | SSL 秘密鍵パス |

## 本番デプロイ（Render 等）

[Render](https://render.com) などのPaaS にデプロイして `https://zengame.saku.hanada.org/admin` からリンクします。

```bash
# Render のダッシュボードで環境変数を設定
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
PORT=3001
```

HTTPS は Render が自動で提供するため、SSL_CERT_PATH / SSL_KEY_PATH の設定は不要です。
