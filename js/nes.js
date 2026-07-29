// ============================================================
// NES / ファミコン本体 (バス・カートリッジ・コントローラ)
// 参考: NESdev Wiki "CPU memory map" / "INES" / "Standard controller"
//       https://www.nesdev.org/wiki/CPU_memory_map
//       https://www.nesdev.org/wiki/INES
// ============================================================

import { CPU } from './cpu.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { createMapper } from './mappers.js';

// iNES ヘッダ解析
export function parseINES(bytes) {
  if (bytes.length < 16 ||
      bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) {
    throw new Error('iNES 形式ではありません (.nes ファイルを指定してください)');
  }
  const prgSize = bytes[4] * 0x4000;
  const chrSize = bytes[5] * 0x2000;
  const flags6 = bytes[6];
  const flags7 = bytes[7];
  const hasTrainer = (flags6 & 0x04) !== 0;
  let offset = 16 + (hasTrainer ? 512 : 0);
  if (bytes.length < offset + prgSize + chrSize) {
    throw new Error('ROM ファイルが壊れています (サイズ不足)');
  }
  return {
    prg: bytes.slice(offset, offset + prgSize),
    chr: bytes.slice(offset + prgSize, offset + prgSize + chrSize),
    mapperId: (flags6 >> 4) | (flags7 & 0xF0),
    mirroring: (flags6 & 0x01) ? 'vertical' : 'horizontal',
    fourScreen: (flags6 & 0x08) !== 0,
    battery: (flags6 & 0x02) !== 0,
  };
}

// 標準コントローラ (ボタン順: A B Select Start Up Down Left Right)
export const BUTTON = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };

class Controller {
  constructor() {
    this.buttons = new Uint8Array(8);
    this.strobe = false;
    this.index = 0;
  }
  setButton(i, pressed) { this.buttons[i] = pressed ? 1 : 0; }
  write(val) {
    this.strobe = (val & 1) !== 0;
    if (this.strobe) this.index = 0;
  }
  read() {
    if (this.strobe) return this.buttons[0] | 0x40;
    const r = this.index < 8 ? this.buttons[this.index] : 1;
    this.index++;
    return r | 0x40; // オープンバス上位ビット
  }
}

export class NES {
  constructor(sampleRate = 44100) {
    this.ram = new Uint8Array(0x800);
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.apu = new APU(this, sampleRate);
    this.mapper = null;
    this.cart = null;
    this.pad1 = new Controller();
    this.pad2 = new Controller();
    this.openBus = 0;
  }

  loadROM(bytes) {
    this.cart = parseINES(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    this.mapper = createMapper(this.cart);
    this.ram.fill(0);
    this.ppu.reset();
    this.cpu.powerOn();
  }

  reset() {
    this.ppu.reset();
    this.cpu.reset();
  }

  // ---- CPU メモリマップ ----
  cpuRead(addr) {
    addr &= 0xFFFF;
    if (addr < 0x2000) return this.ram[addr & 0x7FF];
    if (addr < 0x4000) return this.ppu.readRegister(addr & 7);
    if (addr === 0x4015) return this.apu.readStatus();
    if (addr === 0x4016) return this.pad1.read();
    if (addr === 0x4017) return this.pad2.read();
    if (addr < 0x4020) return this.openBus;
    return this.mapper.cpuRead(addr);
  }

  cpuWrite(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    this.openBus = val;
    if (addr < 0x2000) { this.ram[addr & 0x7FF] = val; return; }
    if (addr < 0x4000) { this.ppu.writeRegister(addr & 7, val); return; }
    if (addr === 0x4014) { this.oamDMA(val); return; }
    if (addr === 0x4016) { this.pad1.write(val); this.pad2.write(val); return; }
    if (addr < 0x4020) { this.apu.writeRegister(addr, val); return; }
    this.mapper.cpuWrite(addr, val);
  }

  oamDMA(page) {
    const base = page << 8;
    for (let i = 0; i < 256; i++) {
      this.ppu.oam[(this.ppu.oamAddr + i) & 0xFF] = this.cpuRead(base + i);
    }
    // 513 or 514 サイクルのストール
    this.cpu.stall += 513 + (this.cpu.stall & 1);
  }

  // ---- 1フレーム実行 ----
  runFrame() {
    this.ppu.frameComplete = false;
    while (!this.ppu.frameComplete) {
      this.cpu.irqLine = this.apu.irqPending() || this.mapper.irqPending();
      const cycles = this.cpu.step();
      for (let i = 0; i < cycles * 3; i++) this.ppu.step();
      for (let i = 0; i < cycles; i++) this.apu.step();
    }
    return this.ppu.frame;
  }

  // ---- バッテリーバックアップ ----
  getBatteryRam() {
    return (this.cart && this.cart.battery) ? this.mapper.prgRam : null;
  }
  setBatteryRam(data) {
    if (this.mapper && data && data.length === this.mapper.prgRam.length) {
      this.mapper.prgRam.set(data);
    }
  }

  // ---- セーブステート ----
  saveState() {
    const c = this.cpu, p = this.ppu, m = this.mapper;
    return {
      ram: Array.from(this.ram),
      cpu: { a: c.a, x: c.x, y: c.y, sp: c.sp, pc: c.pc, p: c.p,
             stall: c.stall, nmiPending: c.nmiPending },
      ppu: {
        vram: Array.from(p.vram), palette: Array.from(p.palette), oam: Array.from(p.oam),
        ctrl: p.ctrl, mask: p.mask, status: p.status, oamAddr: p.oamAddr,
        v: p.v, t: p.t, x: p.x, w: p.w, readBuffer: p.readBuffer,
        scanline: p.scanline, dot: p.dot, frameOdd: p.frameOdd,
      },
      mapper: {
        prgRam: Array.from(m.prgRam),
        chrRam: m.chrIsRam ? Array.from(m.chr) : null,
        state: JSON.parse(JSON.stringify({
          shift: m.shift, control: m.control, chrBank0: m.chrBank0, chrBank1: m.chrBank1,
          prgBank: m.prgBank, bank: m.bank, bankSelect: m.bankSelect,
          banks: m.banks ? Array.from(m.banks) : undefined,
          prgMode: m.prgMode, chrMode: m.chrMode, mirrorMode: m.mirrorMode,
          irqLatch: m.irqLatch, irqCounter: m.irqCounter,
          irqEnable: m.irqEnable, irqReload: m.irqReload, irqFlag: m.irqFlag,
        })),
      },
    };
  }

  loadState(s) {
    if (!s) return;
    this.ram.set(s.ram);
    Object.assign(this.cpu, s.cpu);
    const p = this.ppu;
    p.vram.set(s.ppu.vram); p.palette.set(s.ppu.palette); p.oam.set(s.ppu.oam);
    p.ctrl = s.ppu.ctrl; p.mask = s.ppu.mask; p.status = s.ppu.status;
    p.oamAddr = s.ppu.oamAddr; p.v = s.ppu.v; p.t = s.ppu.t; p.x = s.ppu.x; p.w = s.ppu.w;
    p.readBuffer = s.ppu.readBuffer;
    p.scanline = s.ppu.scanline; p.dot = s.ppu.dot; p.frameOdd = s.ppu.frameOdd;
    const m = this.mapper;
    m.prgRam.set(s.mapper.prgRam);
    if (s.mapper.chrRam && m.chrIsRam) m.chr.set(s.mapper.chrRam);
    const st = s.mapper.state;
    for (const k of Object.keys(st)) {
      if (st[k] === undefined) continue;
      if (k === 'banks' && m.banks) m.banks.set(st[k]);
      else m[k] = st[k];
    }
  }
}
