const qs = new URLSearchParams(location.search);
const role = qs.get('role') || 'guesser';
const roomId = qs.get('room') || '';
const name = qs.get('name') || '';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (...args) => {
  const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logEl.textContent = (logEl.textContent + s + "\n").slice(-5000);
};

$('roleBadge').textContent = `Role: ${role}`;
$('roomBadge').textContent = `Room: ${roomId}`;
$('sub').textContent = `あなた: ${name || '(no name)'}`;

const drawerOnly = $('drawerOnly');
const guesserOnly = $('guesserOnly');

if (role === 'drawer') drawerOnly.classList.remove('hidden');
if (role === 'guesser') guesserOnly.classList.remove('hidden');

const socket = io();
socket.emit('joinRoom', { roomId, role, name });

/* ===== Canvas ===== */
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let drawing = false;
let last = null;

// 描画データ（採点用）
let pointsAll = []; // {x,y,t,down}
let strokesCount = 0;

function clearCanvasLocal() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawSegment(points, color = '#111', size = 3) {
  if (!points || points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ===== Drawer操作（スマホ傾き or マウス） ===== */

let cursor = { x: canvas.width / 2, y: canvas.height / 2 };
let tilt = { beta: 0, gamma: 0 }; // 前後/左右

function startStroke() {
  drawing = true;
  last = { ...cursor };
  strokesCount++;
  pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 1 });
}

function endStroke() {
  drawing = false;
  last = null;
  pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 0 });
}

function addPoint() {
  const p = { x: cursor.x, y: cursor.y };
  if (last) {
    drawSegment([last, p]);
    socket.emit('stroke', { points: [last, p], color: '#111', size: 3 });
  }
  last = p;
  pointsAll.push({ x: p.x, y: p.y, t: Date.now(), down: drawing ? 1 : 0 });
}

function tickTiltDraw() {
  if (role !== 'drawer') return;
  // 傾き→速度
  const vx = clamp(tilt.gamma / 30, -1, 1) * 6; // 左右
  const vy = clamp(tilt.beta / 30, -1, 1) * 6;  // 前後

  cursor.x = clamp(cursor.x + vx, 0, canvas.width);
  cursor.y = clamp(cursor.y + vy, 0, canvas.height);

  // 描画中なら点追加
  if (drawing) addPoint();

  requestAnimationFrame(tickTiltDraw);
}

function enableSensor() {
  $('sensorNote').textContent = 'スマホ傾きでカーソル移動。画面タップで描画ON/OFF。';
  requestAnimationFrame(tickTiltDraw);

  window.addEventListener('deviceorientation', (e) => {
    // iOSは許可が必要（下のボタンで対応）
    tilt.beta = e.beta ?? 0;
    tilt.gamma = e.gamma ?? 0;
  }, true);

// キャンバスだけタップで描画ON/OFF（ボタンや入力を殺さない）
canvas.addEventListener('touchstart', (e) => {
  if (role !== 'drawer') return;

  // iOSでスクロール/ズーム等を抑えて、キャンバス操作だけ優先
  e.preventDefault();

  if (!drawing) startStroke();
  else endStroke();
}, { passive: false });

function enableMouseFallback() {
  $('sensorNote').textContent = 'PC用：マウスで描画できます。';
  canvas.addEventListener('mousedown', (e) => {
    if (role !== 'drawer') return;
    drawing = true;
    strokesCount++;
    const r = canvas.getBoundingClientRect();
    cursor.x = e.clientX - r.left;
    cursor.y = e.clientY - r.top;
    last = { x: cursor.x, y: cursor.y };
    pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 1 });
  });
  canvas.addEventListener('mousemove', (e) => {
    if (role !== 'drawer' || !drawing) return;
    const r = canvas.getBoundingClientRect();
    cursor.x = e.clientX - r.left;
    cursor.y = e.clientY - r.top;
    addPoint();
  });
  window.addEventListener('mouseup', () => {
    if (role !== 'drawer') return;
    if (drawing) endStroke();
  });
}

async function requestIOSPermissionIfNeeded() {
  // iOS 13+ は DeviceOrientationEvent.requestPermission が必要
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    const btn = document.createElement('button');
    btn.textContent = 'iPhone: センサー許可';
    btn.className = 'primary';
    btn.onclick = async () => {
      try {
        const p = await DeviceOrientationEvent.requestPermission();
        if (p === 'granted') {
          btn.remove();
          enableSensor();
        } else {
          alert('許可されませんでした');
        }
      } catch (e) {
        alert('許可に失敗: ' + e.message);
      }
    };
    $('sensorNote').after(btn);
  } else {
    enableSensor();
  }
}

/* ===== 採点（絵のうまさ）※簡易ヒューリスティック ===== */
function computeDrawingScore() {
  // めちゃ簡易：線の長さ/範囲/ストローク数で0-100
  if (pointsAll.length < 10) return 0;

  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  let dist = 0;

  for (let i = 1; i < pointsAll.length; i++) {
    const a = pointsAll[i - 1];
    const b = pointsAll[i];
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x); maxY = Math.max(maxY, b.y);

    if (a.down && b.down) {
      const dx = b.x - a.x, dy = b.y - a.y;
      dist += Math.sqrt(dx*dx + dy*dy);
    }
  }
  const area = (maxX - minX) * (maxY - minY);
  const areaNorm = clamp(area / (canvas.width * canvas.height), 0, 1);

  const distNorm = clamp(dist / 2000, 0, 1);       // 2000pxくらい描けたら十分
  const strokeNorm = clamp(strokesCount / 6, 0, 1); // ストローク多すぎも微妙だが簡易

  const score = Math.round((areaNorm * 40) + (distNorm * 40) + (strokeNorm * 20));
  return clamp(score, 0, 100);
}

/* ===== UI buttons ===== */
$('clearBtn').onclick = () => {
  clearCanvasLocal();
  pointsAll = [];
  strokesCount = 0;
  socket.emit('stroke', { points: [], clear: true }); // 互換用（受信側でclear扱い）
};

$('startBtn').onclick = () => socket.emit('startRound');

$('doneBtn').onclick = () => {
  if (role !== 'drawer') return;
  const drawingScore = computeDrawingScore();
  socket.emit('finishDrawing', { drawingScore });
  log('描き終わり。drawingScore=', drawingScore);
};

$('guessBtn').onclick = () => {
  if (role !== 'guesser') return;
  const guess = $('guessInput').value.trim();
  const drawingScore = Number(window.__lastDrawingScore ?? 0);
  socket.emit('submitGuess', { guess, drawingScore });
};

/* ===== Socket events ===== */
socket.on('errorMessage', (m) => log('ERROR:', m));

socket.on('roomState', (s) => {
  $('roundBadge').textContent = `Round: ${s.round}`;
  log('roomState', s);
});

socket.on('clearCanvas', () => {
  clearCanvasLocal();
  pointsAll = [];
  strokesCount = 0;
  window.__lastDrawingScore = 0;
  $('resultPanel').classList.add('hidden');
  log('キャンバス初期化');
});

socket.on('topicForDrawer', ({ topic, hint, difficulty, round }) => {
  $('topicText').textContent = topic;
  $('hintText').textContent = `ヒント: ${hint}`;
  $('diffText').textContent = `難易度: ${difficulty} / Round: ${round}`;
  log('お題(描く人のみ)=', topic);
});

socket.on('roundStartedForGuesser', ({ round }) => {
  log(`Round ${round} 開始。描く人が描きます…`);
});

socket.on('stroke', (payload) => {
  if (payload?.clear) {
    clearCanvasLocal();
    return;
  }
  const pts = payload.points;
  drawSegment(pts, payload.color || '#111', payload.size || 3);
});

socket.on('drawingFinished', ({ drawingScore }) => {
  window.__lastDrawingScore = Number(drawingScore ?? 0);
  log('描き終わり通知。drawingScore=', window.__lastDrawingScore);
});

socket.on('roundResult', (r) => {
  $('resultPanel').classList.remove('hidden');
  $('resultText').innerHTML = `
    <div class="big">お題：${escapeHtml(r.topic)}</div>
    <div>あなたの解答：${escapeHtml(r.guess)}</div>
    <div class="row">
      <span class="badge">正解: ${r.correct ? '✅' : '❌'}</span>
      <span class="badge">解答スコア: ${r.guessScore}</span>
      <span class="badge">絵スコア: ${r.drawingScore}</span>
      <span class="badge">合計: ${r.totalScore}</span>
    </div>
    <div class="muted">理由: ${escapeHtml(r.reason || '')}</div>
    <div class="muted">正規化: topic=${escapeHtml(r.normalized_topic || '')} / guess=${escapeHtml(r.normalized_guess || '')}</div>
  `;
  log('結果', r);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
  );
}

/* ===== 起動時：描く人はセンサー、だめならマウス ===== */
if (role === 'drawer') {
  // iPhoneなら許可ボタンが出る
  requestIOSPermissionIfNeeded();
  // PCやセンサー無しの保険
  enableMouseFallback();
} else {
  $('sensorNote').textContent = '当てる人はキャンバスを見るだけ。';
}}
