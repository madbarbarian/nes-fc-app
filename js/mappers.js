// ============================================================
// カートリッジマッパー実装
// 参考: NESdev Wiki "Mapper" / "NROM" / "MMC1" / "UxROM" / "CNROM" / "MMC3" / "AxROM"
//       https://www.nesdev.org/wiki/Mapper
// ============================================================

class MapperBase {
  constructor(cart) {
    this.cart = cart;
    this.prg = cart.prg;
    this.chr = cart.chr.length > 0 ? cart.chr : new Uint8Array(0x2000); // CHR RAM
    this.chrIsRam = cart.chr.length === 0;
    this.prgRam = new Uint8Array(0x2000);
    this.mirrorMode = cart.mirroring; // 'horizontal' | 'vertical'
    this.irqFlag = false;
  }
  mirroring() { return this.mirrorMode; }
  irqPending() { return this.irqFlag; }
  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
    return 0;
  }
  cpuWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) this.prgRam[addr - 0x6000] = val;
  }
  ppuRead(addr) { return this.chr[addr & 0x1FFF]; }
  ppuWrite(addr, val) { if (this.chrIsRam) this.chr[addr & 0x1FFF] = val; }
}

// ---- Mapper 0: NROM ----
class NROM extends MapperBase {
  cpuRead(addr) {
    if (addr >= 0x8000) {
      return this.prg[(addr - 0x8000) % this.prg.length];
    }
    return super.cpuRead(addr);
  }
}

// ---- Mapper 1: MMC1 (SxROM) ----
class MMC1 extends MapperBase {
  constructor(cart) {
    super(cart);
    this.shift = 0x10;
    this.control = 0x0C;   // PRG モード3 (末尾固定) で起動
    this.chrBank0 = 0; this.chrBank1 = 0; this.prgBank = 0;
  }
  mirroring() {
    switch (this.control & 3) {
      case 0: return 'single0';
      case 1: return 'single1';
      case 2: return 'vertical';
      default: return 'horizontal';
    }
  }
  cpuRead(addr) {
    if (addr < 0x8000) return super.cpuRead(addr);
    const prgBanks = this.prg.length >> 14; // 16KB 単位
    const mode = (this.control >> 2) & 3;
    let bank;
    if (mode <= 1) { // 32KB モード
      bank = (this.prgBank & 0x0E) % prgBanks;
      return this.prg[((bank << 14) + (addr - 0x8000)) % this.prg.length];
    }
    if (addr < 0xC000) {
      bank = mode === 2 ? 0 : (this.prgBank & 0x0F) % prgBanks;
      return this.prg[(bank << 14) | (addr - 0x8000)];
    }
    bank = mode === 2 ? (this.prgBank & 0x0F) % prgBanks : prgBanks - 1;
    return this.prg[(bank << 14) | (addr - 0xC000)];
  }
  cpuWrite(addr, val) {
    if (addr < 0x8000) { super.cpuWrite(addr, val); return; }
    if (val & 0x80) {
      this.shift = 0x10;
      this.control |= 0x0C;
      return;
    }
    const complete = this.shift & 1;
    this.shift = (this.shift >> 1) | ((val & 1) << 4);
    if (complete) {
      const v = this.shift;
      const region = (addr >> 13) & 3;
      if (region === 0) this.control = v;
      else if (region === 1) this.chrBank0 = v;
      else if (region === 2) this.chrBank1 = v;
      else this.prgBank = v & 0x1F;
      this.shift = 0x10;
    }
  }
  ppuRead(addr) {
    addr &= 0x1FFF;
    const banks4k = Math.max(1, this.chr.length >> 12);
    if (this.control & 0x10) { // 4KB×2 モード
      const bank = addr < 0x1000 ? this.chrBank0 : this.chrBank1;
      return this.chr[(((bank % banks4k) << 12) | (addr & 0xFFF)) % this.chr.length];
    }
    const bank = this.chrBank0 & 0x1E;
    return this.chr[(((bank % banks4k) << 12) + addr) % this.chr.length];
  }
  ppuWrite(addr, val) {
    if (!this.chrIsRam) return;
    addr &= 0x1FFF;
    if (this.control & 0x10) {
      const bank = addr < 0x1000 ? this.chrBank0 : this.chrBank1;
      this.chr[((bank & 1) << 12) | (addr & 0xFFF)] = val;
    } else {
      this.chr[addr] = val;
    }
  }
}

// ---- Mapper 2: UxROM ----
class UxROM extends MapperBase {
  constructor(cart) { super(cart); this.bank = 0; }
  cpuRead(addr) {
    if (addr < 0x8000) return super.cpuRead(addr);
    const banks = this.prg.length >> 14;
    if (addr < 0xC000) {
      return this.prg[((this.bank % banks) << 14) | (addr - 0x8000)];
    }
    return this.prg[((banks - 1) << 14) | (addr - 0xC000)];
  }
  cpuWrite(addr, val) {
    if (addr < 0x8000) { super.cpuWrite(addr, val); return; }
    this.bank = val;
  }
}

// ---- Mapper 3: CNROM ----
class CNROM extends MapperBase {
  constructor(cart) { super(cart); this.bank = 0; }
  cpuRead(addr) {
    if (addr >= 0x8000) return this.prg[(addr - 0x8000) % this.prg.length];
    return super.cpuRead(addr);
  }
  cpuWrite(addr, val) {
    if (addr < 0x8000) { super.cpuWrite(addr, val); return; }
    this.bank = val & 3;
  }
  ppuRead(addr) {
    return this.chr[(((this.bank << 13) | (addr & 0x1FFF))) % this.chr.length];
  }
}

// ---- Mapper 4: MMC3 (TxROM) ----
class MMC3 extends MapperBase {
  constructor(cart) {
    super(cart);
    this.bankSelect = 0;
    this.banks = new Uint8Array(8);
    this.prgMode = 0; this.chrMode = 0;
    this.irqLatch = 0; this.irqCounter = 0;
    this.irqEnable = false; this.irqReload = false;
  }
  cpuRead(addr) {
    if (addr < 0x8000) return super.cpuRead(addr);
    const banks8k = this.prg.length >> 13;
    const last = banks8k - 1;
    let bank;
    const region = (addr >> 13) & 3; // 0:$8000 1:$A000 2:$C000 3:$E000
    if (region === 0) bank = this.prgMode ? last - 1 : this.banks[6] % banks8k;
    else if (region === 1) bank = this.banks[7] % banks8k;
    else if (region === 2) bank = this.prgMode ? this.banks[6] % banks8k : last - 1;
    else bank = last;
    return this.prg[(bank << 13) | (addr & 0x1FFF)];
  }
  cpuWrite(addr, val) {
    if (addr < 0x8000) { super.cpuWrite(addr, val); return; }
    const even = (addr & 1) === 0;
    if (addr < 0xA000) {
      if (even) {
        this.bankSelect = val & 7;
        this.prgMode = (val >> 6) & 1;
        this.chrMode = (val >> 7) & 1;
      } else {
        this.banks[this.bankSelect] = val;
      }
    } else if (addr < 0xC000) {
      if (even) this.mirrorMode = (val & 1) ? 'horizontal' : 'vertical';
      // 奇数: PRG RAM 保護 (省略)
    } else if (addr < 0xE000) {
      if (even) this.irqLatch = val;
      else { this.irqCounter = 0; this.irqReload = true; }
    } else {
      if (even) { this.irqEnable = false; this.irqFlag = false; }
      else this.irqEnable = true;
    }
  }
  ppuRead(addr) {
    addr &= 0x1FFF;
    const banks1k = Math.max(1, this.chr.length >> 10);
    let bank1k;
    const r = this.banks;
    const region = addr >> 10; // 0..7 (1KB 単位)
    if (this.chrMode === 0) {
      // $0000: 2KB×2, $1000: 1KB×4
      if (region < 2) bank1k = (r[0] & 0xFE) | (region & 1);
      else if (region < 4) bank1k = (r[1] & 0xFE) | (region & 1);
      else bank1k = r[region - 2];
    } else {
      if (region < 4) bank1k = r[region + 2];
      else if (region < 6) bank1k = (r[0] & 0xFE) | (region & 1);
      else bank1k = (r[1] & 0xFE) | (region & 1);
    }
    return this.chr[(((bank1k % banks1k) << 10) | (addr & 0x3FF)) % this.chr.length];
  }
  ppuWrite(addr, val) {
    if (this.chrIsRam) this.chr[addr & 0x1FFF] = val;
  }
  // PPU から可視 + プリレンダスキャンラインのドット260で呼ばれる (A12 近似)
  scanline() {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else {
      this.irqCounter--;
    }
    if (this.irqCounter === 0 && this.irqEnable) this.irqFlag = true;
  }
}

// ---- Mapper 7: AxROM ----
class AxROM extends MapperBase {
  constructor(cart) { super(cart); this.bank = 0; this.mirrorMode = 'single0'; }
  cpuRead(addr) {
    if (addr < 0x8000) return super.cpuRead(addr);
    const banks32k = Math.max(1, this.prg.length >> 15);
    return this.prg[((this.bank % banks32k) << 15) | (addr - 0x8000)];
  }
  cpuWrite(addr, val) {
    if (addr < 0x8000) { super.cpuWrite(addr, val); return; }
    this.bank = val & 7;
    this.mirrorMode = (val & 0x10) ? 'single1' : 'single0';
  }
}

const MAPPERS = { 0: NROM, 1: MMC1, 2: UxROM, 3: CNROM, 4: MMC3, 7: AxROM };

export function createMapper(cart) {
  const M = MAPPERS[cart.mapperId];
  if (!M) throw new Error(`未対応のマッパーです: ${cart.mapperId}`);
  return new M(cart);
}

export function supportedMappers() { return Object.keys(MAPPERS).map(Number); }
