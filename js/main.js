// ============================================================
// FC Pocket — UI・入出力まわり
// タッチ操作 / キーボード / Gamepad API / Web Audio / PWA
// ============================================================

import { NES, BUTTON } from './nes.js';
import { buildDemoROM } from './demo.js';
import { buildQixROM } from './qix.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const imageData = ctx.createImageData(256, 240);
const frameBytes = new Uint8ClampedArray(imageData.data.buffer);

let nes = null;
let running = false;
let paused = false;
let muted = false;
let romName = '';
let romHash = '';
let audioCtx = null;
let audioNode = null;
let lastTime = 0;
let accumulator = 0;
const FRAME_MS = 1000 / 60.0988; // NTSC フレームレート

// ---------- ステータス表示 ----------
function status(msg) {
  $('statusLine').textContent = msg;
}

// ---------- オーディオ ----------
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const bufSize = 2048;
    audioNode = audioCtx.createScriptProcessor(bufSize, 0, 1);
    audioNode.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      if (!nes || !running || paused || muted) { out.fill(0); return; }
      const n = nes.apu.readSamples(out);
      // バッファ不足時は最後のサンプルで埋める (プチノイズ防止)
      const last = n > 0 ? out[n - 1] : 0;
      for (let i = n; i < out.length; i++) out[i] = last;
    };
    audioNode.connect(audioCtx.destination);
  } catch (e) {
    console.warn('オーディオ初期化失敗:', e);
  }
}

function resumeAudio() {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// ---------- エミュレーション ----------
async function hashROM(bytes) {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `len${bytes.length}`;
}

async function loadROM(bytes, name) {
  try {
    initAudio();
    const sr = audioCtx ? audioCtx.sampleRate : 44100;
    const machine = new NES(sr);
    machine.loadROM(bytes);
    nes = machine;
    romName = name;
    romHash = await hashROM(bytes);
    // バッテリーセーブ復元
    const saved = localStorage.getItem(`fcp-sram-${romHash}`);
    if (saved) {
      try { nes.setBatteryRam(Uint8Array.from(JSON.parse(saved))); } catch {}
    }
    running = true;
    paused = false;
    $('overlay').hidden = true;
    status(`${name} — マッパー${nes.cart.mapperId}${nes.cart.battery ? ' / バッテリーセーブ対応' : ''}`);
    resumeAudio();
  } catch (e) {
    status(`エラー: ${e.message}`);
    alert(`読み込めませんでした:\n${e.message}`);
  }
}

function saveBattery() {
  if (!nes) return;
  const sram = nes.getBatteryRam();
  if (sram) {
    try {
      localStorage.setItem(`fcp-sram-${romHash}`, JSON.stringify(Array.from(sram)));
    } catch {}
  }
}
setInterval(saveBattery, 10000);
window.addEventListener('pagehide', saveBattery);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { saveBattery(); }
});

// ---------- メインループ ----------
function renderFrame() {
  const frame = nes.runFrame();
  frameBytes.set(new Uint8ClampedArray(frame.buffer, 0, 256 * 240 * 4));
  ctx.putImageData(imageData, 0, 0);
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (!nes || !running || paused) { lastTime = ts; return; }
  pollGamepad();
  if (lastTime === 0) lastTime = ts;
  accumulator += ts - lastTime;
  lastTime = ts;
  if (accumulator > FRAME_MS * 4) accumulator = FRAME_MS * 4; // 追いつき上限
  let drawn = false;
  while (accumulator >= FRAME_MS) {
    renderFrame();
    accumulator -= FRAME_MS;
    drawn = true;
  }
  if (!drawn && accumulator > FRAME_MS * 0.5 && nes.apu.availableSamples() < 1024) {
    // オーディオ枯渇しそうなら1フレーム先行
    renderFrame();
    accumulator = 0;
  }
}
requestAnimationFrame(loop);

// ---------- 入力: タッチ ----------
function bindTouchButton(el) {
  const name = el.dataset.btn;
  const idx = BUTTON[name];
  const press = (on) => {
    if (nes) nes.pad1.setButton(idx, on);
    el.classList.toggle('pressed', on);
    if (on && navigator.vibrate) navigator.vibrate(8);
  };
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); resumeAudio(); press(true); });
  el.addEventListener('pointerup', (e) => { e.preventDefault(); press(false); });
  el.addEventListener('pointercancel', () => press(false));
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') press(false); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
document.querySelectorAll('[data-btn]').forEach(bindTouchButton);

// 十字キーのスライド操作 (指を離さず方向転換)
const dpad = $('dpad');
dpad.addEventListener('pointermove', (e) => {
  if (e.pressure === 0 && e.pointerType !== 'touch') return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || !target.dataset || !target.dataset.btn) return;
  if (!nes) return;
  for (const dir of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
    const el = dpad.querySelector(`[data-btn="${dir}"]`);
    const on = target.dataset.btn === dir;
    nes.pad1.setButton(BUTTON[dir], on);
    el.classList.toggle('pressed', on);
  }
});

// ---------- 入力: キーボード ----------
const KEYMAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  KeyZ: 'B', KeyX: 'A', Enter: 'START', ShiftLeft: 'SELECT', ShiftRight: 'SELECT',
};
window.addEventListener('keydown', (e) => {
  const name = KEYMAP[e.code];
  if (name && nes) { e.preventDefault(); nes.pad1.setButton(BUTTON[name], true); }
});
window.addEventListener('keyup', (e) => {
  const name = KEYMAP[e.code];
  if (name && nes) { e.preventDefault(); nes.pad1.setButton(BUTTON[name], false); }
});

// ---------- 入力: ゲームパッド ----------
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (!gp || !nes) return;
  const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  nes.pad1.setButton(BUTTON.A, b(1) || b(2));
  nes.pad1.setButton(BUTTON.B, b(0) || b(3));
  nes.pad1.setButton(BUTTON.SELECT, b(8));
  nes.pad1.setButton(BUTTON.START, b(9));
  nes.pad1.setButton(BUTTON.UP, b(12) || gp.axes[1] < -0.5);
  nes.pad1.setButton(BUTTON.DOWN, b(13) || gp.axes[1] > 0.5);
  nes.pad1.setButton(BUTTON.LEFT, b(14) || gp.axes[0] < -0.5);
  nes.pad1.setButton(BUTTON.RIGHT, b(15) || gp.axes[0] > 0.5);
}

// ---------- ファイル読み込み ----------
$('btnLoad').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  saveBattery();
  const buf = await file.arrayBuffer();
  await loadROM(new Uint8Array(buf), file.name);
  e.target.value = '';
});

// ドラッグ&ドロップ (PC)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file || !file.name.toLowerCase().endsWith('.nes')) return;
  saveBattery();
  const buf = await file.arrayBuffer();
  await loadROM(new Uint8Array(buf), file.name);
});

// 内蔵ゲーム (QIX 風陣取り)
$('btnDemo').addEventListener('click', async () => {
  saveBattery();
  await loadROM(buildQixROM(), '内蔵ゲーム QIX');
  if (nes && romName === '内蔵ゲーム QIX') {
    status('QIX: 十字キーで空き地を囲んで塗りつぶせ! ●が黄色い線に触れるとミス。バーが▎に届けば勝利');
  }
});

// 表示チェックデモ (旧デモ)
$('btnCheck').addEventListener('click', async () => {
  saveBattery();
  await loadROM(buildDemoROM(), '表示チェックデモ');
  if (nes && romName === '表示チェックデモ') {
    status('チェック: 十字キー=ボール移動 / A・B=色替え / START=スクロール停止 / SELECT=逆走');
  }
  menu.hidden = true; paused = false;
});

// ---------- メニュー ----------
const menu = $('menuPanel');
$('btnMenu').addEventListener('click', () => {
  paused = true;
  menu.hidden = false;
});
$('btnResume').addEventListener('click', () => {
  menu.hidden = true;
  paused = false;
  resumeAudio();
});
menu.addEventListener('click', (e) => {
  if (e.target === menu) { menu.hidden = true; paused = false; }
});
$('btnReset').addEventListener('click', () => {
  if (nes) { nes.reset(); status(`${romName} — リセットしました`); }
  menu.hidden = true; paused = false;
});
$('btnSaveState').addEventListener('click', () => {
  if (!nes) return;
  try {
    localStorage.setItem(`fcp-state-${romHash}`, JSON.stringify(nes.saveState()));
    status(`${romName} — ステートセーブしました`);
  } catch (e) {
    status('ステートセーブ失敗 (容量不足の可能性)');
  }
  menu.hidden = true; paused = false;
});
$('btnLoadState').addEventListener('click', () => {
  if (!nes) return;
  const raw = localStorage.getItem(`fcp-state-${romHash}`);
  if (raw) {
    try {
      nes.loadState(JSON.parse(raw));
      status(`${romName} — ステートロードしました`);
    } catch (e) {
      status('ステートロード失敗');
    }
  } else {
    status('セーブデータがありません');
  }
  menu.hidden = true; paused = false;
});
$('btnMute').addEventListener('click', () => {
  muted = !muted;
  status(muted ? 'サウンド OFF' : 'サウンド ON');
  menu.hidden = true; paused = false;
  resumeAudio();
});

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

status('ROM ファイル (.nes) を読み込むか、内蔵デモをお試しください');
