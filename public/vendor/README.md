# vendor — 同梱している外部ライブラリ

外部CDNに障害が起きても画面が崩れない／QRコードが出なくなることがないよう、
CDNから配布されているファイルをそのまま置いている。

| ファイル | 取得元 | 用途 |
|---|---|---|
| `tailwind.js` | `https://cdn.tailwindcss.com` | 画面のスタイル（Tailwind Play CDN。ブラウザ内でCSSを生成する） |
| `qrcode.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js` | 閲覧画面のQRコード生成 |

取得日: 2026-07-30

## 更新するとき

```bash
curl -sSfL https://cdn.tailwindcss.com -o public/vendor/tailwind.js
curl -sSfL https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js -o public/vendor/qrcode.min.js
node --check public/vendor/tailwind.js && node --check public/vendor/qrcode.min.js
```

## 補足

`tailwind.js` は Tailwind 公式が「本番向けではない」としている Play CDN 版。
ビルド工程を持たない代わりにブラウザ側でCSSを生成するため、初回描画がわずかに遅い。
ビルドを導入すればファイルは数十KBまで小さくできるが、構成が増えるため現状は同梱で済ませている。
