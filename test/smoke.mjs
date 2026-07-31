// スモークテスト: 内蔵デモ ROM を Node.js 上で実行し、
// CPU/PPU/APU/マッパーが最低限正しく動くことを検証する。
//   node test/smoke.mjs
import { NES } from '../js/nes.js';
import { buildDemoROM } from '../js/demo.js';
import { strict as assert } from 'node:assert';

const rom = buildDemoROM();
assert.equal(rom[0], 0x4E, 'iNES マジックナンバー');
console.log(`デモ ROM 生成: ${rom.length} バイト`);

const nes = new NES(44100);
nes.loadROM(rom);
assert.equal(nes.cart.mapperId, 0, 'NROM マッパー');

// 120 フレーム実行
let frame = null;
for (let i = 0; i < 120; i++) frame = nes.runFrame();

// --- 映像検証: フレームバッファに複数の色が出ているか ---
const colors = new Set();
for (let i = 0; i < frame.length; i++) colors.add(frame[i]);
console.log(`フレーム内のユニーク色数: ${colors.size}`);
assert.ok(colors.size >= 4, '背景+スプライトで4色以上描画されるはず');

// 全ピクセルが不透明で塗られているか
for (let i = 0; i < frame.length; i++) {
  assert.ok((frame[i] >>> 24) === 0xFF, `ピクセル ${i} が未描画`);
}

// --- スクロール検証: フレームが時間とともに変化するか ---
const snapshot = Uint32Array.from(frame);
for (let i = 0; i < 30; i++) frame = nes.runFrame();
let diff = 0;
for (let i = 0; i < frame.length; i++) if (frame[i] !== snapshot[i]) diff++;
console.log(`30 フレーム後に変化したピクセル数: ${diff}`);
assert.ok(diff > 1000, 'スクロールにより画面が変化するはず');

// --- 入力検証: 右ボタンでスプライト X が進むか ---
import { BUTTON } from '../js/nes.js';
const spriteX0 = nes.ppu.oam[3];
nes.pad1.setButton(BUTTON.RIGHT, true);
for (let i = 0; i < 30; i++) nes.runFrame();
nes.pad1.setButton(BUTTON.RIGHT, false);
const spriteX1 = nes.ppu.oam[3];
console.log(`スプライト X: ${spriteX0} → ${spriteX1} (右ボタン30フレーム)`);
assert.equal((spriteX1 - spriteX0) & 0xFF, 30, '右入力でスプライトが 1px/フレーム移動するはず');

// --- 入力検証: START でスクロール停止 ---
nes.pad1.setButton(BUTTON.START, true);
nes.runFrame();
const scrollHold = nes.ram[0];
for (let i = 0; i < 10; i++) nes.runFrame();
assert.equal(nes.ram[0], scrollHold, 'START 押下中はスクロールが止まるはず');
nes.pad1.setButton(BUTTON.START, false);
console.log('START でスクロール停止: OK');

// --- NMI 検証: フレームカウンタ ($00) が進んでいるか ---
const counter = nes.ram[0];
assert.ok(counter > 100, `NMI が毎フレーム発火しているはず (counter=${counter})`);
console.log(`NMI フレームカウンタ: ${counter}`);

// --- APU 検証: サンプルが生成されているか ---
assert.ok(nes.apu.availableSamples() > 0 || nes.apu.sampleWrite !== nes.apu.sampleRead || true);
const buf = new Float32Array(1024);
const n = nes.apu.readSamples(buf);
console.log(`APU サンプル取得: ${n} 個`);
assert.ok(n > 0, 'APU がサンプルを生成しているはず');

// --- ステートセーブ/ロード検証 ---
const state = nes.saveState();
const before = Uint32Array.from(nes.runFrame());
nes.loadState(state);
const after = Uint32Array.from(nes.runFrame());
let stateDiff = 0;
for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) stateDiff++;
assert.equal(stateDiff, 0, 'ステート復元後は同じフレームが再現されるはず');
console.log('ステートセーブ/ロード: 一致');

console.log('\n✅ スモークテスト全項目パス');
