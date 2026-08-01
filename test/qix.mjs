// QIX 風内蔵ゲームの自動プレイテスト
//   node test/qix.mjs
import { NES, BUTTON } from '../js/nes.js';
import { buildQixROM } from '../js/qix.js';
import { strict as assert } from 'node:assert';

const FIELD = 0x300;
const PX = 0x02, PY = 0x03, MODE = 0x08, CLM_LO = 0x0B, CLM_HI = 0x0C, WINF = 0x16;
const cell = (nes, row, col) => nes.ram[FIELD + row * 32 + col];

function press(nes, btn, frames) {
  nes.pad1.setButton(BUTTON[btn], true);
  for (let i = 0; i < frames; i++) nes.runFrame();
  nes.pad1.setButton(BUTTON[btn], false);
  nes.runFrame();
}

// 条件を満たすまでボタンを押し続ける
function pressUntil(nes, btn, cond, maxFrames = 300) {
  nes.pad1.setButton(BUTTON[btn], true);
  for (let i = 0; i < maxFrames; i++) {
    nes.runFrame();
    if (cond()) { nes.pad1.setButton(BUTTON[btn], false); nes.runFrame(); return true; }
  }
  nes.pad1.setButton(BUTTON[btn], false);
  return false;
}

function waitMode0(nes, maxFrames = 600) {
  for (let i = 0; i < maxFrames; i++) {
    if (nes.ram[MODE] === 0 || nes.ram[MODE] === 4) return true;
    nes.runFrame();
  }
  return false;
}

const rom = buildQixROM();
console.log(`QIX ROM 生成: ${rom.length} バイト`);

const nes = new NES(44100);
nes.loadROM(rom);
for (let i = 0; i < 30; i++) nes.runFrame();

// --- 初期状態: 外周リングが陣地、内側が空き地 ---
assert.equal(cell(nes, 1, 10), 1, '上リングは陣地');
assert.equal(cell(nes, 28, 10), 1, '下リングは陣地');
assert.equal(cell(nes, 10, 0), 1, '左リングは陣地');
assert.equal(cell(nes, 10, 31), 1, '右リングは陣地');
assert.equal(cell(nes, 10, 10), 0, '内側は空き地');
assert.equal(nes.ram[PX], 16, '自機 X 初期位置');
assert.equal(nes.ram[PY], 28, '自機 Y 初期位置');
console.log('初期フィールド: OK');

// --- リング上の移動: 左に3セル歩く ---
pressUntil(nes, 'LEFT', () => nes.ram[PX] === 13);
assert.equal(nes.ram[PX], 13, 'リング上を左に移動できる');
assert.equal(nes.ram[MODE], 0, '陣地上の移動では充填が起きない');

// --- 囲い込み: 上へ5 → 右へ6 → 下へ5 (右の壁までではなくリングへ戻る) ---
pressUntil(nes, 'UP', () => nes.ram[PY] === 23);
assert.equal(nes.ram[PY], 23, '空き地に侵入');
assert.equal(cell(nes, 27, 13), 2, '通過セルが軌跡になる');
pressUntil(nes, 'RIGHT', () => nes.ram[PX] === 19);
pressUntil(nes, 'DOWN', () => nes.ram[PY] === 28 || nes.ram[MODE] !== 0, 400);

// 囲い完成 → 充填 (MODE 1) → 再描画 (MODE 2) → プレイ再開 (MODE 0)
assert.ok(waitMode0(nes), '充填と再描画が完了する');
const clm = nes.ram[CLM_LO] | (nes.ram[CLM_HI] << 8);
console.log(`塗りつぶし後の陣地セル数: ${clm}`);
// 囲んだ長方形: 行23..27 × 列13..19 (軌跡含む) = 内部が陣地化されているはず
assert.equal(cell(nes, 25, 16), 1, '囲んだ内側が陣地化');
assert.equal(cell(nes, 25, 15), 1, '囲んだ内側が陣地化');
assert.equal(cell(nes, 10, 16), 0, 'Qix 側は空き地のまま');
assert.ok(clm >= 20 && clm < 200, `陣地数が妥当 (${clm})`);

// --- ミス: 空き地に線を引いて放置 → Qix が軌跡に触れてリセット ---
pressUntil(nes, 'LEFT', () => nes.ram[PX] === 8);
pressUntil(nes, 'UP', () => nes.ram[PY] === 14, 600); // 中央付近まで線を引いて待つ
let died = false;
for (let i = 0; i < 3600; i++) { // 最大60秒ぶん
  nes.runFrame();
  if (nes.ram[MODE] === 3 || nes.ram[MODE] === 2) { died = true; break; }
}
assert.ok(died, 'Qix が軌跡に触れてミスになる');
assert.ok(waitMode0(nes), 'ミス後の再描画が完了する');
assert.equal(nes.ram[PX], 16, 'ミス後にスタート位置へ戻る');
assert.equal(nes.ram[PY], 28, 'ミス後にスタート位置へ戻る');
// 軌跡が消えている
let trails = 0;
for (let r = 2; r < 28; r++) for (let c = 1; c < 31; c++) if (cell(nes, r, c) === 2) trails++;
assert.equal(trails, 0, 'ミス後は軌跡が消える');
console.log('ミス処理: OK');

// --- 勝利: 大きく囲って 75% 達成 ---
// 左端の列2まで移動し、上へ大きく囲う: 上26 → 右へ大きく → 下へ戻る
function bigClaim(fromX, toX, topY) {
  pressUntil(nes, nes.ram[PX] > fromX ? 'LEFT' : 'RIGHT', () => nes.ram[PX] === fromX, 600);
  pressUntil(nes, 'UP', () => nes.ram[PY] === topY, 600);
  pressUntil(nes, 'RIGHT', () => nes.ram[PX] === toX, 600);
  pressUntil(nes, 'DOWN', () => nes.ram[MODE] !== 0 || nes.ram[PY] === 28, 600);
  return waitMode0(nes);
}
// Qix は上半分にいることが多いので、下半分を横いっぱいに囲うのを繰り返す
let won = false;
for (let attempt = 0; attempt < 12 && !won; attempt++) {
  const qy = nes.ram[0x05] >> 3; // Qix の行
  const topY = Math.min(26, Math.max(3, qy + 3)); // Qix より下側を狙う
  bigClaim(2, 29, topY);
  if (nes.ram[MODE] === 4) { won = true; break; }
  if (nes.ram[MODE] !== 0) waitMode0(nes);
  if (nes.ram[WINF] === 1 || nes.ram[MODE] === 4) { won = true; break; }
  // ミスした場合もあるのでそのまま次の試行へ
}
const clmFinal = nes.ram[CLM_LO] | (nes.ram[CLM_HI] << 8);
console.log(`最終陣地セル数: ${clmFinal} / 780 (勝利ライン585)`);
assert.ok(won || clmFinal >= 585, '勝利条件に到達できる');
assert.ok(waitMode0(nes), '勝利後も安定');
console.log(`勝利モード: MODE=${nes.ram[MODE]} WINF=${nes.ram[WINF]}`);

// --- 画面検証: フレームに陣地色が出ているか ---
const frame = nes.runFrame();
const colors = new Set();
for (const px of frame) colors.add(px >>> 0);
assert.ok(colors.size >= 3, '複数色が描画されている');

console.log('\n✅ QIX テスト全項目パス');
