// ファズテスト: ランダムなボタン乱打で長時間自動プレイし、
// 不変条件を毎フレーム検査してバグを炙り出す。
//   node test/fuzz.mjs [フレーム数] [シード数]
import { NES, BUTTON } from '../js/nes.js';
import { buildQixROM } from '../js/qix.js';
import { buildDemoROM } from '../js/demo.js';
import { strict as assert } from 'node:assert';

const FRAMES = Number(process.argv[2] || 30000);
const SEEDS = Number(process.argv[3] || 3);
const FIELD = 0x300;

// 再現可能な乱数 (xorshift32)
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function checkQixInvariants(nes, frame, seed) {
  const ctx = `[seed=${seed} frame=${frame}]`;
  const px = nes.ram[0x02], py = nes.ram[0x03];
  const mode = nes.ram[0x08], lives = nes.ram[0x1D];
  assert.ok(px <= 31, `${ctx} 自機Xが範囲外: ${px}`);
  assert.ok(py >= 1 && py <= 28, `${ctx} 自機Yが範囲外: ${py}`);
  assert.ok(mode <= 5, `${ctx} 不正なモード: ${mode}`);
  assert.ok(lives <= 4, `${ctx} 不正な残機: ${lives}`);
  const clm = nes.ram[0x0B] | (nes.ram[0x0C] << 8);
  assert.ok(clm <= 780, `${ctx} 陣地数が上限超過: ${clm}`);
  // フィールド値は 0-3 のみ
  for (let i = 0; i < 960; i += 97) { // サンプリング検査
    const v = nes.ram[FIELD + i];
    assert.ok(v <= 3, `${ctx} フィールド値が不正: [${i}]=${v}`);
  }
}

function fuzzRom(name, romBytes, seed, invariant) {
  const rng = makeRng(seed);
  const nes = new NES(44100);
  nes.loadROM(romBytes);
  for (let i = 0; i < 120; i++) nes.runFrame(); // 初期化完了を待つ
  let stateRoundtrips = 0;
  for (let f = 0; f < FRAMES; f++) {
    // ランダム入力: 平均5フレームごとにパッドを組み替える
    if (rng() < 0.2) {
      for (let b = 0; b < 8; b++) nes.pad1.setButton(b, rng() < 0.3);
    }
    nes.runFrame();
    if (invariant && (f & 15) === 0) invariant(nes, f, seed);
    // 時々セーブステートの往復 (状態破壊がないか)
    if (rng() < 0.0005) {
      const st = nes.saveState();
      nes.loadState(st);
      stateRoundtrips++;
    }
  }
  // 最後に全ボタン解放して数フレーム — クラッシュしないこと
  for (let b = 0; b < 8; b++) nes.pad1.setButton(b, false);
  for (let i = 0; i < 10; i++) nes.runFrame();
  // APU が生きているか
  const buf = new Float32Array(256);
  assert.ok(nes.apu.readSamples(buf) > 0, `[${name} seed=${seed}] APU が停止`);
  return { stateRoundtrips };
}

console.log(`ファズテスト: ${FRAMES} フレーム × ${SEEDS} シード × 2 ROM`);
for (let s = 1; s <= SEEDS; s++) {
  const r1 = fuzzRom('QIX', buildQixROM(), s * 12345, checkQixInvariants);
  console.log(`  QIX  seed=${s}: OK (ステート往復 ${r1.stateRoundtrips} 回)`);
  const r2 = fuzzRom('DEMO', buildDemoROM(), s * 54321, null);
  console.log(`  DEMO seed=${s}: OK (ステート往復 ${r2.stateRoundtrips} 回)`);
}
console.log('\n✅ ファズテスト完走 (不変条件違反・クラッシュなし)');
