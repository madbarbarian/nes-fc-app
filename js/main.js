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
// AudioWorklet (推奨) → ScriptProcessor の順で初期化。
// iOS Safari は入力0chの ScriptProcessor が発火しない事があるため 1ch で作る。
const WORKLET_SRC = `
class FcpOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(16384);
    this.r = 0; this.w = 0; this.last = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i < d.length; i++) {
        const n = (this.w + 1) & 16383;
        if (n !== this.r) { this.buf[this.w] = d[i]; this.w = n; }
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.r !== this.w) { this.last = this.buf[this.r]; this.r = (this.r + 1) & 16383; }
      else { this.last *= 0.999; } // 枯渇時はフェードしてプチノイズ防止
      out[i] = this.last;
    }
    return true;
  }
}
registerProcessor('fcp-output', FcpOutput);
`;

let audioMode = 'none';
let workletNode = null;
let audioInitPromise = null;
const audioTmp = new Float32Array(8192);

function initAudio() {
  if (audioInitPromise) return audioInitPromise;
  audioInitPromise = (async () => {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS 16.4+: マナーモード (サイレントスイッチ) でも鳴らす
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'playback'; } catch {}
      }
      if (audioCtx.audioWorklet) {
        try {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
          await audioCtx.audioWorklet.addModule(url);
          workletNode = new AudioWorkletNode(audioCtx, 'fcp-output', {
            numberOfInputs: 0, outputChannelCount: [1],
          });
          workletNode.connect(audioCtx.destination);
          audioMode = 'worklet';
        } catch (e) {
          console.warn('AudioWorklet 初期化失敗、ScriptProcessor に切替:', e);
        }
      }
      if (audioMode !== 'worklet') {
        audioNode = audioCtx.createScriptProcessor(2048, 1, 1);
        audioNode.onaudioprocess = (e) => {
          const out = e.outputBuffer.getChannelData(0);
          if (!nes || !running || paused || muted) { out.fill(0); return; }
          const n = nes.apu.readSamples(out);
          const last = n > 0 ? out[n - 1] : 0;
          for (let i = n; i < out.length; i++) out[i] = last;
        };
        audioNode.connect(audioCtx.destination);
        audioMode = 'script';
      }
      // デバッグ用
      window.__fcpAudio = {
        get mode() { return audioMode; },
        get state() { return audioCtx ? audioCtx.state : 'none'; },
        get pumped() { return pumpedSamples; },
      };
    } catch (e) {
      console.warn('オーディオ初期化失敗:', e);
    }
  })();
  return audioInitPromise;
}

function resumeAudio() {
  initAudio().then(() => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  });
}

// AudioWorklet モード: メインループから毎フレームサンプルを送る
let pumpedSamples = 0;
function pumpAudio() {
  if (!nes || audioMode !== 'worklet') return;
  const n = nes.apu.readSamples(audioTmp); // ミュート中も読み捨ててバッファ溢れ防止
  if (n > 0 && !muted && running && !paused && workletNode) {
    workletNode.port.postMessage(audioTmp.slice(0, n));
    pumpedSamples += n;
  }
}

// どこをタップ/クリック/キー入力しても音声を有効化 (モバイルの自動再生制限対策)
document.addEventListener('pointerdown', resumeAudio, { capture: true });
document.addEventListener('keydown', resumeAudio, { capture: true });

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
    await initAudio();
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
  pumpAudio();
  // 音声がブラウザにブロックされたままならヒントを表示
  if (!audioHintShown && audioCtx && audioCtx.state === 'suspended' && !muted) {
    audioHintShown = true;
    status('🔇 音を出すには画面をどこかタップしてください');
  }
}
let audioHintShown = false;
requestAnimationFrame(loop);

// ---------- 入力: タッチ (指ごとに追跡するマルチタッチ + スライド対応) ----------
// 各ポインタ(指)がいまどのボタンの上にあるかを Map で管理し、
// 変化のたびに全ボタンの押下状態を再計算する。
// これにより「スライドで方向転換したあと指を離すとボタンが残る」バグを防ぐ。
const controls = $('controls');
const btnEls = {};
document.querySelectorAll('[data-btn]').forEach((el) => { btnEls[el.dataset.btn] = el; });
const heldByPointer = new Map();   // pointerId → ボタン名
const touchActive = new Set();     // 現在タッチで押されているボタン名

function applyTouchState(newlyPressed) {
  touchActive.clear();
  for (const name of heldByPointer.values()) if (name) touchActive.add(name);
  for (const name of Object.keys(btnEls)) {
    const on = touchActive.has(name);
    if (nes) nes.pad1.setButton(BUTTON[name], on);
    btnEls[name].classList.toggle('pressed', on);
  }
  if (newlyPressed && navigator.vibrate) navigator.vibrate(8);
}

function buttonAt(x, y) {
  const t = document.elementFromPoint(x, y);
  const el = t && t.closest ? t.closest('[data-btn]') : null;
  return el ? el.dataset.btn : null;
}

controls.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // ボタン外で触れても追跡は開始する (スライドでボタンに入れるように)
  const name = buttonAt(e.clientX, e.clientY);
  heldByPointer.set(e.pointerId, name);
  applyTouchState(!!name);
});
controls.addEventListener('pointermove', (e) => {
  if (!heldByPointer.has(e.pointerId)) return; // 押下中の指のみ追跡
  const name = buttonAt(e.clientX, e.clientY);
  const prev = heldByPointer.get(e.pointerId);
  if (name === prev) return;
  heldByPointer.set(e.pointerId, name); // 隙間の上では null (どのボタンも押されない)
  applyTouchState(!!name);
});
function releasePointer(e) {
  if (!heldByPointer.has(e.pointerId)) return;
  heldByPointer.delete(e.pointerId);
  applyTouchState(false);
}
// 離す操作はどこで起きても確実に拾う (キャプチャ先が別要素でも取りこぼさない)
window.addEventListener('pointerup', releasePointer, { capture: true });
window.addEventListener('pointercancel', releasePointer, { capture: true });
window.addEventListener('blur', () => { heldByPointer.clear(); applyTouchState(false); });
controls.addEventListener('contextmenu', (e) => e.preventDefault());

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
  // タッチ入力を上書きしないよう OR で合成する
  const t = (name) => touchActive.has(name);
  nes.pad1.setButton(BUTTON.A, b(1) || b(2) || t('A'));
  nes.pad1.setButton(BUTTON.B, b(0) || b(3) || t('B'));
  nes.pad1.setButton(BUTTON.SELECT, b(8) || t('SELECT'));
  nes.pad1.setButton(BUTTON.START, b(9) || t('START'));
  nes.pad1.setButton(BUTTON.UP, b(12) || gp.axes[1] < -0.5 || t('UP'));
  nes.pad1.setButton(BUTTON.DOWN, b(13) || gp.axes[1] > 0.5 || t('DOWN'));
  nes.pad1.setButton(BUTTON.LEFT, b(14) || gp.axes[0] < -0.5 || t('LEFT'));
  nes.pad1.setButton(BUTTON.RIGHT, b(15) || gp.axes[0] > 0.5 || t('RIGHT'));
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

// デバッグ用: 現在のパッド状態
window.__fcpPad = () => (nes ? Array.from(nes.pad1.buttons) : null);

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

status('ROM ファイル (.nes) を読み込むか、内蔵デモをお試しください');
