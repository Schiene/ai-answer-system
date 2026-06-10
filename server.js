'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── 起動時バリデーション ───────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('[fatal] GEMINI_API_KEY が設定されていません。.env を確認してください。');
  process.exit(1);
}

// ── 設定 ────────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT              || '3001');
const ROOM_ID_LENGTH = parseInt(process.env.ROOM_ID_LENGTH    || '10');
const ROOM_EXPIRY_MS = parseInt(process.env.ROOM_EXPIRY_MINUTES || '60') * 60 * 1000;
const RATE_LIMIT_MS  = parseInt(process.env.RATE_LIMIT_SECONDS  || '10') * 1000;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SSL_CERT       = process.env.SSL_CERT_PATH;
const SSL_KEY        = process.env.SSL_KEY_PATH;

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ヘルスチェック（Render / ロードバランサー向け）
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

// Gemini API 疎通確認（デバッグ用）
app.get('/test-ai', async (_req, res) => {
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent('日本語で「テスト成功」とだけ答えてください。');
    const text = result.response.text().trim();
    res.json({ ok: true, model: GEMINI_MODEL, text });
  } catch (err) {
    res.json({ ok: false, model: GEMINI_MODEL, error: err.message });
  }
});

// ── HTTPS / HTTP 自動切り替え ─────────────────────────────────────────────
let server;
if (SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
  server = https.createServer(
    { cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) },
    app,
  );
  console.log('[server] HTTPS mode');
} else {
  server = http.createServer(app);
  console.log('[server] HTTP mode (HTTPS requires SSL_CERT_PATH / SSL_KEY_PATH)');
}

// ── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(server);

// ── Gemini API ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 429 エラーからリトライ待機時間(ms)を取り出す
function parseRetryDelay(err) {
  const match = err?.message?.match(/retry[^"]*"?(\d+)s/i);
  return match ? parseInt(match[1]) * 1000 : 15_000;
}

async function analyzeImage(base64Jpeg) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const call = () => model.generateContent([
    '画像に写っている問題を解き、答えだけを簡潔に出力してください。解説や問題文は不要です。',
    { inlineData: { data: base64Jpeg, mimeType: 'image/jpeg' } },
  ]);

  let res;
  try {
    res = await call();
  } catch (err) {
    // レート制限の場合は一度だけ自動リトライ
    if (err?.message?.includes('429')) {
      const delay = parseRetryDelay(err);
      console.warn(`[ai] rate limited, retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      res = await call();
    } else {
      throw err;
    }
  }
  const answer = res.response.text().trim();
  if (!answer) throw new Error('AIから回答が得られませんでした');
  return { answer };
}

// ── ルーム管理 ───────────────────────────────────────────────────────────────
const rooms = new Map();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomId() {
  let id = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    id += ROOM_CHARS[crypto.randomInt(0, ROOM_CHARS.length)];
  }
  return id;
}

// 期限切れルームを定期削除
const expiryInterval = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.createdAt >= ROOM_EXPIRY_MS) {
      io.to(roomId).emit('room_expired', { roomId });
      io.in(roomId).socketsLeave(roomId);
      rooms.delete(roomId);
      console.log(`[room] expired: ${roomId}`);
    }
  }
}, 60_000);

// ── Socket.io イベント ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Display → Backend: ルーム作成
  socket.on('create_room', () => {
    let roomId;
    let tries = 0;
    do { roomId = generateRoomId(); tries++; }
    while (rooms.has(roomId) && tries < 20);

    const room = {
      displaySocketId: socket.id,
      cameraSocketId: null,
      createdAt: Date.now(),
      lastImageAt: 0,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role   = 'display';

    socket.emit('room_created', { roomId, expiresAt: room.createdAt + ROOM_EXPIRY_MS });
    console.log(`[room] created: ${roomId}`);
  });

  // Camera → Backend: ルーム参加
  socket.on('join_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error_occurred', {
        code: 'ROOM_NOT_FOUND',
        message: 'ルームが見つかりません。IDを確認してください。',
      });
      return;
    }
    if (Date.now() - room.createdAt >= ROOM_EXPIRY_MS) {
      rooms.delete(roomId);
      socket.emit('error_occurred', {
        code: 'ROOM_EXPIRED',
        message: 'ルームの有効期限が切れています。',
      });
      return;
    }
    room.cameraSocketId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role   = 'camera';

    socket.to(roomId).emit('camera_connected');
    socket.emit('join_ack', { roomId, expiresAt: room.createdAt + ROOM_EXPIRY_MS });
    console.log(`[room] camera joined: ${roomId}`);
  });

  // Camera → Backend: 画像送信
  socket.on('image_captured', async ({ roomId, imageData }, ack) => {
    const room = rooms.get(roomId);
    if (!room) {
      if (ack) ack({ error: 'ROOM_NOT_FOUND' });
      return;
    }
    const now = Date.now();
    if (now - room.lastImageAt < RATE_LIMIT_MS) {
      if (ack) ack({ error: 'RATE_LIMITED' });
      return;
    }
    room.lastImageAt = now;
    if (ack) ack({ ok: true });

    io.to(roomId).emit('ai_processing_start');

    try {
      const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
      const result = await analyzeImage(base64);
      io.to(roomId).emit('ai_result_ready', result);
      console.log(`[ai] result sent to room: ${roomId}`);
    } catch (err) {
      console.error('[ai] error:', err.message);
      let userMsg = `AI処理エラー: ${err?.message || '不明なエラー'}`;
      if (err?.message?.includes('429')) {
        userMsg = 'APIの使用量制限に達しました。しばらく待ってから再試行してください。';
      } else if (err?.message?.includes('API_KEY') || err?.message?.includes('403')) {
        userMsg = 'APIキーが無効です。Render の環境変数を確認してください。';
      }
      io.to(roomId).emit('ai_error', {
        message: userMsg,
      });
    }
  });

  // 切断処理
  socket.on('disconnect', () => {
    const { roomId, role } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (role === 'camera') {
      room.cameraSocketId = null;
      socket.to(roomId).emit('camera_disconnected');
      console.log(`[room] camera disconnected: ${roomId}`);
    } else if (role === 'display') {
      io.in(roomId).socketsLeave(roomId);
      rooms.delete(roomId);
      console.log(`[room] display closed, room deleted: ${roomId}`);
    }
  });
});

// ── 起動 ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const proto = (SSL_CERT && SSL_KEY) ? 'https' : 'http';
  console.log(`[server] listening on ${proto}://localhost:${PORT}`);
  console.log(`[server] model: ${GEMINI_MODEL}`);
});

// ── グレースフルシャットダウン ────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down…`);
  clearInterval(expiryInterval);
  server.close(() => {
    console.log('[server] HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
