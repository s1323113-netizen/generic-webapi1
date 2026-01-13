const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// 設定をコードで定義（あなたの今の環境のままでOK）
//const PROVIDER = 'openai';       // 'openai' or 'gemini'
//const MODEL = 'gpt-4o-mini';     // OpenAI: 'gpt-4o-mini', Gemini: 'gemini-2.5-flash'

const PROVIDER = 'gemini';
const MODEL = 'gemini-2.5-flash';

let promptTemplate;
try {
  promptTemplate = fs.readFileSync('prompt.md', 'utf8');
} catch (error) {
  console.error('Error reading prompt.md:', error);
  process.exit(1);
}

const OPENAI_API_ENDPOINT = "https://openai-api-proxy-746164391621.us-west1.run.app";
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * 既存の /api/ はそのまま（互換）
 * - body.prompt があればそれを使う
 * - なければ prompt.md を使う
 */
app.post('/api/', async (req, res) => {
  try {
    const { prompt, title = 'Generated Content', ...variables } = req.body;

    let finalPrompt = prompt || promptTemplate;

    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
      finalPrompt = finalPrompt.replace(regex, value);
    }

    let result;
    if (PROVIDER === 'openai') result = await callOpenAI(finalPrompt);
    else if (PROVIDER === 'gemini') result = await callGemini(finalPrompt);
    else return res.status(400).json({ error: 'Invalid provider configuration' });

    res.json({ title, data: result });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');

  const response = await fetch(OPENAI_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: prompt }],
      max_completion_tokens: 2000,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'OpenAI API error');
  }

  const data = await response.json();
  const responseText = data.choices[0].message.content;

  try {
    const parsed = JSON.parse(responseText);
    const arrayData = Object.values(parsed).find(Array.isArray);
    if (!arrayData) throw new Error('No array found in the LLM response object.');
    return arrayData;
  } catch (e) {
    throw new Error('Failed to parse LLM response: ' + e.message);
  }
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set');

  const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 3000,
        response_mime_type: "application/json"
      }
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Gemini API error');
  }

  const data = await response.json();
  const responseText = data.candidates[0].content.parts[0].text;

  try {
    const parsed = JSON.parse(responseText);
    const arrayData = Object.values(parsed).find(Array.isArray);
    if (!arrayData) throw new Error('No array found in the LLM response object.');
    return arrayData;
  } catch (e) {
    throw new Error('Failed to parse LLM response: ' + e.message);
  }
}

/* ===========================
   ここから：対戦ゲーム用 Socket.IO
=========================== */

const server = http.createServer(app);
const io = new Server(server);

// ルーム状態（メモリ。授業用途ならOK）
const rooms = new Map();
/**
 * rooms.get(roomId) = {
 *   drawerSocketId: string|null,
 *   guesserSocketId: string|null,
 *   drawerName: string,
 *   guesserName: string,
 *   topic: string|null,        // お題（描く人だけに送る）
 *   round: number,
 *   drawingDone: boolean
 * }
 */

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      drawerSocketId: null,
      guesserSocketId: null,
      drawerName: 'Drawer',
      guesserName: 'Guesser',
      topic: null,
      round: 0,
      drawingDone: false
    });
  }
  return rooms.get(roomId);
}

function publicState(room) {
  return {
    drawerConnected: !!room.drawerSocketId,
    guesserConnected: !!room.guesserSocketId,
    drawerName: room.drawerName,
    guesserName: room.guesserName,
    round: room.round,
    drawingDone: room.drawingDone
  };
}

async function llmGenerateTopic() {
  // /api/ と同じロジックを「サーバ内」で呼ぶため、callOpenAI/callGeminiを直で使う
  const prompt = `
あなたは「お絵かき当てゲーム」の出題AIです。
日本語で、日常物/キャラ/食べ物/動物/乗り物などを中心に、難易度がバラけるようにお題を1つだけ作ってください。
禁止：固有名詞の有名キャラ（例：ドラえもん等）は避ける。
出力は必ずJSONオブジェクトで、配列を1つ含める。

出力形式:
{
  "data": [
    {
      "topic": "お題（日本語）",
      "hint": "ヒント（短い）",
      "difficulty": 1〜3
    }
  ]
}
`.trim();

  const arr = (PROVIDER === 'openai') ? await callOpenAI(prompt) : await callGemini(prompt);
  const first = arr?.[0] || {};
  const topic = String(first.topic || 'ねこ');
  const hint = String(first.hint || '動物');
  const difficulty = Number(first.difficulty || 1);
  return { topic, hint, difficulty };
}

async function llmJudgeGuess(topic, guess) {
  const prompt = `
あなたは「お絵かき当てゲーム」の判定AIです。
お題(topic)と解答(guess)が同じ意味なら正解とする（表記ゆれ/言い換えOK）。
部分的に合っている場合は部分点を与える。

topic: "${topic}"
guess: "${guess}"

出力は必ずJSONオブジェクトで、配列を1つ含める。
{
  "data": [
    {
      "correct": true/false,
      "score": 0〜100,
      "reason": "短い理由（日本語）",
      "normalized_topic": "topicを一言で言い換え",
      "normalized_guess": "guessを一言で言い換え"
    }
  ]
}
`.trim();

  const arr = (PROVIDER === 'openai') ? await callOpenAI(prompt) : await callGemini(prompt);
  const r = arr?.[0] || {};
  return {
    correct: !!r.correct,
    score: Math.max(0, Math.min(100, Number(r.score ?? 0))),
    reason: String(r.reason || ''),
    normalized_topic: String(r.normalized_topic || ''),
    normalized_guess: String(r.normalized_guess || '')
  };
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, role, name }) => {
    roomId = String(roomId || '').trim();
    role = String(role || '').trim();
    name = String(name || '').trim().slice(0, 20) || (role === 'drawer' ? 'Drawer' : 'Guesser');

    if (!roomId) return socket.emit('errorMessage', 'roomId が空です');

    socket.join(roomId);
    const room = getOrCreateRoom(roomId);

    if (role === 'drawer') {
      room.drawerSocketId = socket.id;
      room.drawerName = name;
      socket.data.role = 'drawer';
    } else if (role === 'guesser') {
      room.guesserSocketId = socket.id;
      room.guesserName = name;
      socket.data.role = 'guesser';
    } else {
      return socket.emit('errorMessage', 'role は drawer/guesser のどちらかです');
    }

    socket.data.roomId = roomId;

    io.to(roomId).emit('roomState', publicState(room));
  });

  socket.on('startRound', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getOrCreateRoom(roomId);

    // 両方いる時だけ開始
    if (!room.drawerSocketId || !room.guesserSocketId) {
      return io.to(roomId).emit('errorMessage', '2人揃ってから開始してね');
    }

    // 描く人だけが開始ボタン押せる（簡易）
    if (socket.id !== room.drawerSocketId) {
      return socket.emit('errorMessage', '開始は描く人だけ');
    }

    room.round += 1;
    room.drawingDone = false;
    room.topic = null;

    // 全員にキャンバス初期化指示
    io.to(roomId).emit('clearCanvas');

    // LLMでお題生成 → 描く人にだけ送る
    try {
      const { topic, hint, difficulty } = await llmGenerateTopic();
      room.topic = topic;

      io.to(room.drawerSocketId).emit('topicForDrawer', { topic, hint, difficulty, round: room.round });
      io.to(room.guesserSocketId).emit('roundStartedForGuesser', { round: room.round }); // お題は送らない
      io.to(roomId).emit('roomState', publicState(room));
    } catch (e) {
      io.to(roomId).emit('errorMessage', 'お題生成に失敗: ' + e.message);
    }
  });

  // 線（描画データ）を送る：描く人→当てる人
  socket.on('stroke', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);

    if (socket.id !== room.drawerSocketId) return; // 描く人以外は無視
    // payload: { points:[{x,y,down}], color, size }
    socket.to(roomId).emit('stroke', payload);
  });

  socket.on('finishDrawing', ({ drawingScore }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);
    if (socket.id !== room.drawerSocketId) return;

    room.drawingDone = true;
    io.to(roomId).emit('drawingFinished', { drawingScore: Number(drawingScore ?? 0) });
    io.to(roomId).emit('roomState', publicState(room));
  });

  // 当てる人が回答送信 → LLMで判定
  socket.on('submitGuess', async ({ guess, drawingScore }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);

    if (socket.id !== room.guesserSocketId) return;
    if (!room.topic) return socket.emit('errorMessage', 'お題がまだ生成されてないかも');

    guess = String(guess || '').trim();
    if (!guess) return socket.emit('errorMessage', '解答が空だよ');

    try {
      const judged = await llmJudgeGuess(room.topic, guess);

      const ds = Math.max(0, Math.min(100, Number(drawingScore ?? 0)));
      const total = Math.round((judged.score * 0.7) + (ds * 0.3));

      io.to(roomId).emit('roundResult', {
        topic: room.topic,                 // 結果発表のときだけ全員に公開
        guess,
        correct: judged.correct,
        guessScore: judged.score,
        drawingScore: ds,
        totalScore: total,
        reason: judged.reason,
        normalized_topic: judged.normalized_topic,
        normalized_guess: judged.normalized_guess
      });
    } catch (e) {
      io.to(roomId).emit('errorMessage', '判定に失敗: ' + e.message);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = getOrCreateRoom(roomId);

    if (room.drawerSocketId === socket.id) room.drawerSocketId = null;
    if (room.guesserSocketId === socket.id) room.guesserSocketId = null;

    // どっちもいなくなったら掃除（任意）
    if (!room.drawerSocketId && !room.guesserSocketId) {
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit('roomState', publicState(room));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Config: ${PROVIDER} - ${MODEL}`);
});