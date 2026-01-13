const qs = new URLSearchParams(location.search);
const role = qs.get('role') || 'guesser';
const roomId = qs.get('room') || '';
const name = qs.get('name') || '';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (...args) => {
  const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  if (!logEl) return;
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
const cursorDot = $('cursorDot');

// 背景色（消しゴム色）
const CANVAS_BG = '#ffffff';

// 画面回転/リサイズで絵を保つ
let snapshotDataUrl = null;
function snapshotCanvas() {
  try { snapshotDataUrl = canvas.toDataURL('image/png'); }
  catch { snapshotDataUrl = null; }
}
function restoreSnapshot() {
  if (!snapshotDataUrl) return;
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, canvas.clientWidth, canvas.clientHeight);
  img.src = snapshotDataUrl;
}

function fillBackground() {
  ctx.save();
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.restore();
}

function resizeCanvasToContainer() {
  const wrap = canvas.parentElement; // .canvasWrap
  const rect = wrap.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fillBackground();
}

window.addEventListener('resize', () => {
  snapshotCanvas();
  resizeCanvasToContainer();
  restoreSnapshot();
  updateCursorDot();
});

// 初期
resizeCanvasToContainer();

/* ===== 状態 ===== */
let penColor = '#111111';
let penSize = 3;
let eraser = false;

let penDown = false;
let last = null;
let cursor = { x: 100, y: 100 };
let tilt = { beta: 0, gamma: 0 };

// 採点用
let pointsAll = [];
let strokesCount = 0;

// Undo（軽くするため回数制限）
const undoStack = [];
const UNDO_LIMIT = 30;

function pushUndo() {
  try {
    const url = canvas.toDataURL('image/png');
    undoStack.push(url);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  } catch {}
}

function applyUndo() {
  const url = undoStack.pop();
  if (!url) return;

  fillBackground();

  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, canvas.clientWidth, canvas.clientHeight);
  img.src = url;
}

function clearCanvasLocal() {
  fillBackground();
}

function getStrokeColor() {
  return eraser ? CANVAS_BG : penColor;
}
function getStrokeSize() {
  return eraser ? 18 : penSize;
}

function drawSegment(points, color, size) {
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

/* ===== カーソル表示 ===== */
function updateCursorDot() {
  if (!cursorDot) return;

  if (role !== 'drawer') {
    cursorDot.classList.add('hidden');
    return;
  }
  cursorDot.classList.remove('hidden');

  cursorDot.style.transform = `translate(${cursor.x - 9}px, ${cursor.y - 9}px)`;
  cursorDot.classList.toggle('drawing', penDown);

  if (eraser) {
    cursorDot.style.borderColor = 'rgba(0,0,0,.65)';
    cursorDot.style.background = 'rgba(200,200,200,.55)';
    cursorDot.style.boxShadow = '0 0 0 2px rgba(255,255,255,.85)';
  } else {
    cursorDot.style.borderColor = penColor;
    cursorDot.style.background = penColor + '33';
    cursorDot.style.boxShadow = '0 0 0 2px rgba(255,255,255,.85)';
  }
}

/* ===== 描画処理 ===== */
function setPenDown(next) {
  const prev = penDown;
  penDown = !!next;

  const status = $('statusPen');
  if (status) status.textContent = penDown ? 'PEN: ON' : 'PEN: OFF';
  const btn = $('penToggleBtn');
  if (btn) btn.textContent = penDown ? 'ペンON（描画中）' : 'ペンOFF（移動のみ）';

  if (!prev && penDown) {
    pushUndo();
    strokesCount++;
    last = { ...cursor };
    pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 1 });
  }

  if (prev && !penDown) {
    last = null;
    pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 0 });
  }

  updateCursorDot();
}

function addPointAndEmit() {
  const p = { x: cursor.x, y: cursor.y };
  if (last) {
    const color = getStrokeColor();
    const size = getStrokeSize();
    drawSegment([last, p], color, size);
    socket.emit('stroke', { points: [last, p], color, size });
  }
  last = p;
  pointsAll.push({ x: p.x, y: p.y, t: Date.now(), down: penDown ? 1 : 0 });
}

function edgeDampen(pos, min, max) {
  const margin = 20;
  if (pos < min + margin) return 0.4;
  if (pos > max - margin) return 0.4;
  return 1.0;
}

function tickTiltDraw() {
  if (role !== 'drawer') return;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  const vxRaw = clamp(tilt.gamma / 30, -1, 1) * 5;
  const vyRaw = clamp(tilt.beta / 30, -1, 1) * 5;

  const dampX = edgeDampen(cursor.x, 0, w);
  const dampY = edgeDampen(cursor.y, 0, h);

  cursor.x = clamp(cursor.x + vxRaw * dampX, 0, w);
  cursor.y = clamp(cursor.y + vyRaw * dampY, 0, h);

  if (penDown) addPointAndEmit();
  updateCursorDot();

  requestAnimationFrame(tickTiltDraw);
}

function enableSensor() {
  $('sensorNote').textContent =
    'スマホ：傾きでカーソル移動。ペンON/OFFボタンで描画。';

  window.addEventListener('deviceorientation', (e) => {
    tilt.beta = e.beta ?? 0;
    tilt.gamma = e.gamma ?? 0;
  }, true);

  cursor.x = canvas.clientWidth / 2;
  cursor.y = canvas.clientHeight / 2;
  updateCursorDot();

  requestAnimationFrame(tickTiltDraw);
}

function enableMouseFallback() {
  $('sensorNote').textContent = 'PC用：マウスで描画できます。';

  let drawing = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (role !== 'drawer') return;
    if (e.pointerType === 'touch') return;

    pushUndo();
    drawing = true;
    strokesCount++;

    const r = canvas.getBoundingClientRect();
    cursor.x = clamp(e.clientX - r.left, 0, canvas.clientWidth);
    cursor.y = clamp(e.clientY - r.top, 0, canvas.clientHeight);
    last = { x: cursor.x, y: cursor.y };
    pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 1 });

    updateCursorDot();
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (role !== 'drawer' || !drawing) return;

    const r = canvas.getBoundingClientRect();
    cursor.x = clamp(e.clientX - r.left, 0, canvas.clientWidth);
    cursor.y = clamp(e.clientY - r.top, 0, canvas.clientHeight);

    addPointAndEmit();
    updateCursorDot();
  });

  canvas.addEventListener('pointerup', () => {
    if (role !== 'drawer') return;
    if (!drawing) return;
    drawing = false;
    last = null;
    pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 0 });
    updateCursorDot();
  });
}

async function requestIOSPermissionIfNeeded() {
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

/* ===== 採点 ===== */
function computeDrawingScore() {
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
      dist += Math.sqrt(dx * dx + dy * dy);
    }
  }
  const area = (maxX - minX) * (maxY - minY);
  const areaNorm = clamp(area / (canvas.clientWidth * canvas.clientHeight), 0, 1);
  const distNorm = clamp(dist / 2000, 0, 1);
  const strokeNorm = clamp(strokesCount / 6, 0, 1);

  const score = Math.round((areaNorm * 40) + (distNorm * 40) + (strokeNorm * 20));
  return clamp(score, 0, 100);
}

/* ===== UI buttons ===== */
$('clearBtn').onclick = () => {
  pushUndo();
  clearCanvasLocal();
  pointsAll = [];
  strokesCount = 0;
  socket.emit('stroke', { points: [], clear: true });
};

const undoBtn = $('undoBtn');
if (undoBtn) {
  undoBtn.onclick = () => {
    applyUndo();
    last = null;
    pointsAll.push({ x: cursor.x, y: cursor.y, t: Date.now(), down: 0 });
    updateCursorDot();
  };
}

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

const penBtn = $('penToggleBtn');
if (penBtn) {
  penBtn.onclick = () => setPenDown(!penDown);
}

function setTool({ color, isEraser }) {
  eraser = !!isEraser;
  if (!eraser && color) penColor = color;

  const info = $('colorInfo');
  if (info) info.textContent = eraser ? '消しゴム' : `色: ${penColor}`;

  updateCursorDot();
}

function bindColorBtn(id, color) {
  const el = $(id);
  if (!el) return;
  el.onclick = () => setTool({ color, isEraser: false });
}

bindColorBtn('colBlack',  '#111111');
bindColorBtn('colRed',    '#e11d48');
bindColorBtn('colBlue',   '#2563eb');
bindColorBtn('colGreen',  '#16a34a');
bindColorBtn('colYellow', '#facc15');
bindColorBtn('colPurple', '#a855f7');
bindColorBtn('colCyan',   '#06b6d4');
bindColorBtn('colOrange', '#f97316');
bindColorBtn('colBrown',  '#8b5a2b');

const er = $('colEraser');
if (er) er.onclick = () => setTool({ isEraser: true });

const picker = $('colorPicker');
if (picker) {
  picker.addEventListener('input', () => {
    setTool({ color: picker.value, isEraser: false });
  });
}

/* ===== 紙吹雪 ===== */
function fireConfetti() {
  if (typeof confetti !== 'function') return;

  const duration = 1200;
  const end = Date.now() + duration;

  (function frame() {
    confetti({
      particleCount: 6,
      spread: 70,
      startVelocity: 35,
      origin: { x: Math.random() * 0.2 + 0.4, y: 0.2 }
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

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

  // ✅ 正解時だけ紙吹雪
  if (r.correct) fireConfetti();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ===== 起動時 ===== */
if (role === 'drawer') {
  requestIOSPermissionIfNeeded();
  enableMouseFallback();
  setPenDown(false);
  setTool({ color: '#111111', isEraser: false });
  cursor.x = canvas.clientWidth / 2;
  cursor.y = canvas.clientHeight / 2;
  updateCursorDot();
} else {
  $('sensorNote').textContent = '当てる人はキャンバスを見るだけ。';
  if (cursorDot) cursorDot.classList.add('hidden');
}
