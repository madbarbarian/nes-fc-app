// QIX 風内蔵ゲームの自動プレイテスト
//   node test/qix.mjs
import { NES, BUTTON } from '../js/nes.js';
import { buildQixROM } from '../js/qix.js';
import { strict as assert } from 'node:assert';

const FIELD = 0x300;
const PX = 0x02, PY = 0x03, MODE = 0x08, CLM_LO = 0x0B, CLM_HI = 0x0C, WINF = 0x16;
const LIVES = 0x1D, PCT = 0x1E, SPEED = 0x1F;
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
pressUntil(nes, 'UP', () => nes.ram[PY] === 14 || nes.ram[MODE] !== 0, 600); // 中央付近まで線を引いて待つ
let died = false;
for (let i = 0; i < 3600; i++) { // 最大60秒ぶん
  nes.runFrame();
  if (nes.ram[MODE] === 3 || nes.ram[MODE] === 2) { died = true; break; }
}
assert.ok(died, 'Qix が軌跡に触れてミスになる');
assert.ok(waitMode0(nes), 'ミス後の再描画が完了する');
assert.equal(nes.ram[PX], 16, 'ミス後にスタート位置へ戻る');
assert.equal(nes.ram[PY], 28, 'ミス後にスタート位置へ戻る');
assert.equal(nes.ram[LIVES], 3, 'ミスで残機が減る (4→3)');
// 軌跡が消えている
let trails = 0;
for (let r = 2; r < 28; r++) for (let c = 1; c < 31; c++) if (cell(nes, r, c) === 2) trails++;
assert.equal(trails, 0, 'ミス後は軌跡が消える');
console.log('ミス処理: OK');

// --- 勝利: 本家の定石「敵から遠い列を縦一直線にカットして半分ずつ奪う」 ---
// 列ごとの空き地の底 (最下端の空き行) を調べる
function emptyBottom(col) {
  for (let r = 27; r >= 2; r--) if (cell(nes, r, col) === 0) return r;
  return -1;
}
// 敵と空き地の端との中間の列を選ぶ (1カットで残り領域の約半分を取る)
function pickCutColumn() {
  const qcol = nes.ram[0x04] >> 3;
  const empties = [];
  for (let c = 2; c <= 29; c++) if (emptyBottom(c) >= 2) empties.push(c);
  if (empties.length === 0) return null;
  const minE = empties[0], maxE = empties[empties.length - 1];
  // 敵から遠い側の中間点を狙う
  const target = (maxE - qcol > qcol - minE)
    ? Math.floor((qcol + maxE) / 2)
    : Math.floor((qcol + minE) / 2);
  // target に空きがなければ近い空き列へ
  let best = null;
  for (const c of empties) {
    const d = Math.abs(c - target);
    if (!best || d < best.d) best = { c, d };
  }
  return best;
}
function verticalCut() {
  const pick = pickCutColumn();
  if (!pick) return;
  pressUntil(nes, 'DOWN', () => nes.ram[PY] === 28 || nes.ram[MODE] !== 0, 400);
  if (nes.ram[MODE] !== 0) return;
  const dir = nes.ram[PX] > pick.c ? 'LEFT' : 'RIGHT';
  pressUntil(nes, dir, () => nes.ram[PX] === pick.c || nes.ram[MODE] !== 0, 600);
  if (nes.ram[MODE] !== 0) return;
  // 人間の立ち回り: 敵がカット列から横に離れるまで壁の上で待つ
  for (let i = 0; i < 600; i++) {
    const qcol = nes.ram[0x04] >> 3;
    if (Math.abs(qcol - pick.c) >= 6) break;
    nes.runFrame();
  }
  // 上端の壁に届くと囲いが閉じ、敵のいない側が塗られる
  pressUntil(nes, 'UP', () => nes.ram[MODE] !== 0, 500);
}
// ボットで到達できる範囲を確認 (50% 以上でゲームとして成立とみなす)
let best = 0;
for (let attempt = 0; attempt < 80; attempt++) {
  if (nes.ram[MODE] === 5) { // ゲームオーバーなら START で再挑戦
    press(nes, 'START', 5);
    for (let i = 0; i < 10; i++) nes.runFrame();
    continue;
  }
  if (nes.ram[MODE] === 4) break;
  verticalCut();
  if (nes.ram[MODE] !== 0 && nes.ram[MODE] !== 5) waitMode0(nes);
  best = Math.max(best, nes.ram[CLM_LO] | (nes.ram[CLM_HI] << 8));
  if (best >= 400) break;
}
console.log(`自動プレイ最高到達: ${best} / 780 セル`);
assert.ok(best >= 400, `自動プレイで50%以上到達できる (${best})`);

// --- 勝利遷移: 75%目前の状態を作って最後のひと囲いで勝利する ---
{
  const nesW = new NES(44100);
  nesW.loadROM(buildQixROM());
  for (let i = 0; i < 30; i++) nesW.runFrame();
  const cellW = (r, c) => nesW.ram[FIELD + r * 32 + c];
  // 行7以下をすべて陣地化 (敵の巣は上側に残す) → 約605セル
  for (let r = 7; r <= 27; r++) {
    for (let c = 1; c <= 30; c++) nesW.ram[FIELD + r * 32 + c] = 1;
  }
  // 敵を上側の空き地に移動
  nesW.ram[0x04] = 120; nesW.ram[0x05] = 32; // qx, qy (行4付近)
  // 最小の囲い: 空き地 (行6) に1セルだけ踏み込んですぐ戻る → 充填発生
  pressUntil(nesW, 'UP', () => nesW.ram[PY] === 6 || nesW.ram[MODE] !== 0, 600);
  pressUntil(nesW, 'DOWN', () => nesW.ram[MODE] !== 0, 200);
  for (let i = 0; i < 900; i++) {
    if (nesW.ram[MODE] === 4) break;
    nesW.runFrame();
  }
  assert.equal(nesW.ram[MODE], 4, '75%達成で勝利モードに入る');
  assert.ok(nesW.ram[PCT] >= 75, `獲得率が75%以上 (${nesW.ram[PCT]}%)`);
  assert.equal(nesW.ram[SPEED], 2, '獲得率70%超で敵が2倍速');
  console.log(`勝利遷移: OK (PCT=${nesW.ram[PCT]}%)`);

  // --- 勝利後 START でリスタート ---
  press(nesW, 'START', 5);
  for (let i = 0; i < 10; i++) nesW.runFrame();
  assert.equal(nesW.ram[MODE], 0, 'START でリスタート');
  assert.equal(nesW.ram[LIVES], 4, 'リスタートで残機が戻る');
  const clmRestart = nesW.ram[CLM_LO] | (nesW.ram[CLM_HI] << 8);
  assert.equal(clmRestart, 0, 'リスタートでフィールドが初期化');
  console.log('リスタート: OK');
}

// --- ゲームオーバー: 4回ミスで MODE=5 ---
const nes2 = new NES(44100);
nes2.loadROM(buildQixROM());
for (let i = 0; i < 30; i++) nes2.runFrame();
for (let death = 1; death <= 4; death++) {
  // 中央へ線を引いて放置し、Qix に切らせる
  pressUntil(nes2, 'UP', () => nes2.ram[PY] === 14 || nes2.ram[MODE] !== 0, 600);
  let hit = false;
  for (let i = 0; i < 7200; i++) {
    nes2.runFrame();
    if (nes2.ram[MODE] === 3 || nes2.ram[MODE] === 2) { hit = true; break; }
  }
  assert.ok(hit, `${death}回目のミスが発生する`);
  for (let i = 0; i < 300; i++) {
    nes2.runFrame();
    if (nes2.ram[MODE] === 0 || nes2.ram[MODE] === 5) break;
  }
  if (death < 4) {
    assert.equal(nes2.ram[LIVES], 4 - death, `残機 ${4 - death}`);
    assert.equal(nes2.ram[MODE], 0, 'まだプレイ続行');
  }
}
assert.equal(nes2.ram[MODE], 5, '残機0でゲームオーバーモード');
press(nes2, 'START', 5);
for (let i = 0; i < 10; i++) nes2.runFrame();
assert.equal(nes2.ram[MODE], 0, 'ゲームオーバーから START で再挑戦');
assert.equal(nes2.ram[LIVES], 4, '再挑戦で残機4');
console.log('ゲームオーバー: OK');

// --- 敵の尾: 履歴が更新され、尾が軌跡に触れるとミスになる ---
{
  const nes3 = new NES(44100);
  nes3.loadROM(buildQixROM());
  for (let i = 0; i < 60; i++) nes3.runFrame();
  const HISTX = 0x24, HISTY = 0x30, TAIL_LEN = 12;
  const hist0 = Array.from(nes3.ram.slice(HISTX, HISTX + TAIL_LEN));
  for (let i = 0; i < 60; i++) nes3.runFrame();
  const hist1 = Array.from(nes3.ram.slice(HISTX, HISTX + TAIL_LEN));
  assert.notDeepEqual(hist0, hist1, '尾の履歴が敵の移動で更新される');
  // OAM に尾スプライト (タイル16) が12個並ぶ
  let tails = 0;
  for (let s = 2; s < 2 + TAIL_LEN; s++) if (nes3.ram[0x200 + s * 4 + 1] === 16) tails++;
  assert.equal(tails, TAIL_LEN, '尾スプライトが12個描画される');
  // グニャグニャ検証: 壁に触れない短期間でも進行方向が変わる (ランダム方向転換)
  {
    const dirs = new Set();
    let prevX = nes3.ram[0x04], prevY = nes3.ram[0x05];
    for (let i = 0; i < 240; i++) {
      nes3.runFrame();
      const qx = nes3.ram[0x04], qy = nes3.ram[0x05];
      dirs.add(`${Math.sign(qx - prevX)},${Math.sign(qy - prevY)}`);
      prevX = qx; prevY = qy;
    }
    assert.ok(dirs.size >= 3, `敵の進行方向がランダムに変化する (${dirs.size}方向)`);
  }
  // 尾の1点の真下に軌跡セルを置く → 接触判定でミスになる
  const tx = nes3.ram[HISTX + 3] >> 3, ty = nes3.ram[HISTY + 3] >> 3;
  nes3.ram[FIELD + ty * 32 + tx] = 2;
  let tailKill = false;
  for (let i = 0; i < 5; i++) {
    nes3.runFrame();
    if (nes3.ram[MODE] === 3 || nes3.ram[MODE] === 2) { tailKill = true; break; }
  }
  assert.ok(tailKill, '尾が軌跡に触れるとミスになる');
  console.log('敵の尾: OK');
}

// --- 画面検証: フレームに陣地色が出ているか ---
const frame = nes.runFrame();
const colors = new Set();
for (const px of frame) colors.add(px >>> 0);
assert.ok(colors.size >= 3, '複数色が描画されている');

console.log('\n✅ QIX テスト全項目パス');
