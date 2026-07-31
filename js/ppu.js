// ============================================================
// PPU (2C02) エミュレーション — ドット単位レンダリング
// 参考: NESdev Wiki "PPU registers" / "PPU scrolling" / "PPU rendering"
//       https://www.nesdev.org/wiki/PPU_registers
//       https://www.nesdev.org/wiki/PPU_scrolling  (内部レジスタ v/t/x/w)
// ============================================================

// NTSC 2C02 マスターパレット (FCEUX 系の標準的な RGB 値)
export const NES_PALETTE = new Uint32Array([
  0x666666, 0x002A88, 0x1412A7, 0x3B00A4, 0x5C007E, 0x6E0040, 0x6C0600, 0x561D00,
  0x333500, 0x0B4800, 0x005200, 0x004F08, 0x00404D, 0x000000, 0x000000, 0x000000,
  0xADADAD, 0x155FD9, 0x4240FF, 0x7527FE, 0xA01ACC, 0xB71E7B, 0xB53120, 0x994E00,
  0x6B6D00, 0x388700, 0x0C9300, 0x008F32, 0x007C8D, 0x000000, 0x000000, 0x000000,
  0xFFFEFF, 0x64B0FF, 0x9290FF, 0xC676FF, 0xF36AFF, 0xFE6ECC, 0xFE8170, 0xEA9E22,
  0xBCBE00, 0x88D800, 0x5CE430, 0x45E082, 0x48CDDE, 0x4F4F4F, 0x000000, 0x000000,
  0xFFFEFF, 0xC0DFFF, 0xD3D2FF, 0xE8C8FF, 0xFBC2FF, 0xFEC4EA, 0xFECCC5, 0xF7D8A5,
  0xE4E594, 0xCFEF96, 0xBDF4AB, 0xB3F3CC, 0xB5EBF2, 0xB8B8B8, 0x000000, 0x000000,
]);

export class PPU {
  constructor(bus) {
    this.bus = bus;                       // NES 本体 (mapper / cpu へのアクセス)
    this.vram = new Uint8Array(0x800);    // ネームテーブル 2KB
    this.palette = new Uint8Array(0x20);  // パレット RAM
    this.oam = new Uint8Array(0x100);     // スプライト用 OAM

    // フレームバッファ (ABGR32 / little-endian で RGBA として描画)
    this.frame = new Uint32Array(256 * 240);

    // レジスタ
    this.ctrl = 0;      // $2000 PPUCTRL
    this.mask = 0;      // $2001 PPUMASK
    this.status = 0;    // $2002 PPUSTATUS
    this.oamAddr = 0;   // $2003 OAMADDR

    // loopy 内部レジスタ (NESdev Wiki "PPU scrolling")
    this.v = 0;         // 現在の VRAM アドレス (15bit)
    this.t = 0;         // テンポラリ VRAM アドレス
    this.x = 0;         // ファイン X スクロール (3bit)
    this.w = 0;         // 書き込みトグル

    this.readBuffer = 0;    // $2007 読み出しバッファ
    this.openBus = 0;

    // タイミング
    this.scanline = 261;    // プリレンダから開始
    this.dot = 0;
    this.frameOdd = false;
    this.frameComplete = false;

    // 背景シフトレジスタ
    this.ntByte = 0; this.atByte = 0;
    this.bgLow = 0; this.bgHigh = 0;
    this.bgShiftLow = 0; this.bgShiftHigh = 0;
    this.atShiftLow = 0; this.atShiftHigh = 0;
    this.atLatchLow = 0; this.atLatchHigh = 0;

    // スキャンラインごとのスプライト (最大8)
    this.spCount = 0;
    this.spPatternLow = new Uint8Array(8);
    this.spPatternHigh = new Uint8Array(8);
    this.spX = new Int16Array(8);
    this.spAttr = new Uint8Array(8);
    this.spIsZero = new Uint8Array(8);
  }

  reset() {
    this.ctrl = 0; this.mask = 0; this.w = 0;
    this.scanline = 261; this.dot = 0;
    this.frameOdd = false;
  }

  renderingEnabled() { return (this.mask & 0x18) !== 0; }

  // ---- ネームテーブルミラーリング ----
  ntAddr(addr) {
    addr &= 0x0FFF;
    const table = addr >> 10;       // 0..3
    const off = addr & 0x3FF;
    switch (this.bus.mapper.mirroring()) {
      case 'vertical':   return ((table & 1) << 10) | off;
      case 'horizontal': return ((table >> 1) << 10) | off;
      case 'single0':    return off;
      case 'single1':    return 0x400 | off;
      default:           return ((table & 1) << 10) | off;
    }
  }

  // ---- PPU アドレス空間の読み書き ----
  ppuRead(addr) {
    addr &= 0x3FFF;
    if (addr < 0x2000) return this.bus.mapper.ppuRead(addr);
    if (addr < 0x3F00) return this.vram[this.ntAddr(addr)];
    // パレット ($3F10/$3F14/... は $3F00/... のミラー)
    let p = addr & 0x1F;
    if ((p & 0x13) === 0x10) p &= ~0x10;
    return this.palette[p];
  }

  ppuWrite(addr, val) {
    addr &= 0x3FFF;
    if (addr < 0x2000) { this.bus.mapper.ppuWrite(addr, val); return; }
    if (addr < 0x3F00) { this.vram[this.ntAddr(addr)] = val; return; }
    let p = addr & 0x1F;
    if ((p & 0x13) === 0x10) p &= ~0x10;
    this.palette[p] = val & 0x3F;
  }

  // ---- CPU からのレジスタアクセス ($2000-$2007) ----
  readRegister(reg) {
    switch (reg) {
      case 2: { // PPUSTATUS
        const r = (this.status & 0xE0) | (this.openBus & 0x1F);
        this.status &= ~0x80;   // VBlank フラグクリア
        this.w = 0;             // 書き込みトグルリセット
        return r;
      }
      case 4: return this.oam[this.oamAddr];
      case 7: { // PPUDATA
        let r;
        if ((this.v & 0x3FFF) < 0x3F00) {
          r = this.readBuffer;
          this.readBuffer = this.ppuRead(this.v);
        } else {
          r = this.ppuRead(this.v);
          this.readBuffer = this.vram[this.ntAddr(this.v)];
        }
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
        return r;
      }
    }
    return this.openBus;
  }

  writeRegister(reg, val) {
    this.openBus = val;
    switch (reg) {
      case 0: { // PPUCTRL
        const prevNMI = this.ctrl & 0x80;
        this.ctrl = val;
        // t: ...GH.. ........ <- d: ......GH (ネームテーブル選択)
        this.t = (this.t & 0x73FF) | ((val & 0x03) << 10);
        // VBlank 中に NMI 有効化すると即 NMI
        if (!prevNMI && (val & 0x80) && (this.status & 0x80)) {
          this.bus.cpu.triggerNMI();
        }
        break;
      }
      case 1: this.mask = val; break;
      case 3: this.oamAddr = val; break;
      case 4:
        this.oam[this.oamAddr] = val;
        this.oamAddr = (this.oamAddr + 1) & 0xFF;
        break;
      case 5: // PPUSCROLL
        if (this.w === 0) {
          this.t = (this.t & 0x7FE0) | (val >> 3);
          this.x = val & 0x07;
          this.w = 1;
        } else {
          this.t = (this.t & 0x0C1F) | ((val & 0x07) << 12) | ((val & 0xF8) << 2);
          this.w = 0;
        }
        break;
      case 6: // PPUADDR
        if (this.w === 0) {
          this.t = (this.t & 0x00FF) | ((val & 0x3F) << 8);
          this.w = 1;
        } else {
          this.t = (this.t & 0x7F00) | val;
          this.v = this.t;
          this.w = 0;
        }
        break;
      case 7: // PPUDATA
        this.ppuWrite(this.v, val);
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
        break;
    }
  }

  // ---- loopy スクロール処理 ----
  incrementX() {
    if ((this.v & 0x001F) === 31) {
      this.v &= ~0x001F;
      this.v ^= 0x0400;   // 水平ネームテーブル切り替え
    } else {
      this.v++;
    }
  }

  incrementY() {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
    } else {
      this.v &= ~0x7000;
      let y = (this.v & 0x03E0) >> 5;
      if (y === 29) {
        y = 0;
        this.v ^= 0x0800; // 垂直ネームテーブル切り替え
      } else if (y === 31) {
        y = 0;
      } else {
        y++;
      }
      this.v = (this.v & ~0x03E0) | (y << 5);
    }
  }

  copyX() { this.v = (this.v & ~0x041F) | (this.t & 0x041F); }
  copyY() { this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0); }

  // ---- 背景フェッチ ----
  loadShifters() {
    this.bgShiftLow = (this.bgShiftLow & 0xFF00) | this.bgLow;
    this.bgShiftHigh = (this.bgShiftHigh & 0xFF00) | this.bgHigh;
    this.atLatchLow = this.atByte & 1;
    this.atLatchHigh = (this.atByte >> 1) & 1;
  }

  fetchBackground(phase) {
    switch (phase) {
      case 1:
        this.loadShifters();
        this.ntByte = this.ppuRead(0x2000 | (this.v & 0x0FFF));
        break;
      case 3: {
        const at = this.ppuRead(0x23C0 | (this.v & 0x0C00) |
                                ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07));
        const shift = ((this.v >> 4) & 4) | (this.v & 2);
        this.atByte = (at >> shift) & 3;
        break;
      }
      case 5: {
        const fineY = (this.v >> 12) & 7;
        const base = (this.ctrl & 0x10) ? 0x1000 : 0;
        this.bgLow = this.ppuRead(base + this.ntByte * 16 + fineY);
        break;
      }
      case 7: {
        const fineY = (this.v >> 12) & 7;
        const base = (this.ctrl & 0x10) ? 0x1000 : 0;
        this.bgHigh = this.ppuRead(base + this.ntByte * 16 + fineY + 8);
        break;
      }
    }
  }

  // ---- スプライト評価 (次のスキャンライン用・簡略版) ----
  evaluateSprites(line) {
    this.spCount = 0;
    const size = (this.ctrl & 0x20) ? 16 : 8;
    let found = 0;
    for (let i = 0; i < 64; i++) {
      const y = this.oam[i * 4];
      const row = line - y;
      if (row < 0 || row >= size) continue;
      if (found >= 8) { this.status |= 0x20; break; } // スプライトオーバーフロー
      const tile = this.oam[i * 4 + 1];
      const attr = this.oam[i * 4 + 2];
      const sx = this.oam[i * 4 + 3];
      let r = (attr & 0x80) ? (size - 1 - row) : row; // 垂直反転
      let addr;
      if (size === 16) {
        const bank = (tile & 1) ? 0x1000 : 0;
        let t = tile & 0xFE;
        if (r >= 8) { t++; r -= 8; }
        addr = bank + t * 16 + r;
      } else {
        const bank = (this.ctrl & 0x08) ? 0x1000 : 0;
        addr = bank + tile * 16 + r;
      }
      let low = this.ppuRead(addr);
      let high = this.ppuRead(addr + 8);
      if (attr & 0x40) { // 水平反転
        low = reverseByte(low);
        high = reverseByte(high);
      }
      this.spPatternLow[found] = low;
      this.spPatternHigh[found] = high;
      this.spX[found] = sx;
      this.spAttr[found] = attr;
      this.spIsZero[found] = (i === 0) ? 1 : 0;
      found++;
    }
    this.spCount = found;
  }

  // ---- 1ピクセル描画 ----
  renderPixel() {
    const px = this.dot - 1;
    const py = this.scanline;

    // 背景ピクセル
    let bgPixel = 0, bgPal = 0;
    if (this.mask & 0x08) {
      if ((this.mask & 0x02) || px >= 8) {
        const bit = 15 - this.x;
        bgPixel = (((this.bgShiftHigh >> bit) & 1) << 1) | ((this.bgShiftLow >> bit) & 1);
        bgPal = (((this.atShiftHigh >> (7 - this.x)) & 1) << 1) |
                ((this.atShiftLow >> (7 - this.x)) & 1);
      }
    }

    // スプライトピクセル
    let spPixel = 0, spPal = 0, spBehind = false, spZero = false;
    if (this.mask & 0x10) {
      if ((this.mask & 0x04) || px >= 8) {
        for (let i = 0; i < this.spCount; i++) {
          const off = px - this.spX[i];
          if (off < 0 || off >= 8) continue;
          const p = (((this.spPatternHigh[i] >> (7 - off)) & 1) << 1) |
                    ((this.spPatternLow[i] >> (7 - off)) & 1);
          if (p === 0) continue;
          spPixel = p;
          spPal = this.spAttr[i] & 3;
          spBehind = (this.spAttr[i] & 0x20) !== 0;
          spZero = this.spIsZero[i] === 1;
          break; // 若い番号のスプライトが優先
        }
      }
    }

    // 合成 + スプライト0ヒット
    let colorIndex;
    if (bgPixel === 0 && spPixel === 0) {
      colorIndex = this.palette[0];
    } else if (bgPixel === 0) {
      colorIndex = this.palette[0x10 + spPal * 4 + spPixel];
    } else if (spPixel === 0) {
      colorIndex = this.palette[bgPal * 4 + bgPixel];
    } else {
      if (spZero && px < 255) this.status |= 0x40; // スプライト0ヒット
      colorIndex = spBehind
        ? this.palette[bgPal * 4 + bgPixel]
        : this.palette[0x10 + spPal * 4 + spPixel];
    }

    const rgb = NES_PALETTE[colorIndex & 0x3F];
    // Canvas 用 RGBA (little-endian ABGR)
    this.frame[py * 256 + px] =
      0xFF000000 | ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF);
  }

  shiftBackground() {
    this.bgShiftLow = (this.bgShiftLow << 1) & 0xFFFF;
    this.bgShiftHigh = (this.bgShiftHigh << 1) & 0xFFFF;
    this.atShiftLow = ((this.atShiftLow << 1) | this.atLatchLow) & 0xFF;
    this.atShiftHigh = ((this.atShiftHigh << 1) | this.atLatchHigh) & 0xFF;
  }

  // ---- 1ドット進める ----
  step() {
    const line = this.scanline;
    const dot = this.dot;
    const rendering = this.renderingEnabled();
    const visible = line < 240;
    const preRender = line === 261;

    if (rendering && (visible || preRender)) {
      // 背景パイプライン
      if ((dot >= 1 && dot <= 256) || (dot >= 321 && dot <= 336)) {
        if (visible && dot <= 256) this.renderPixel();
        this.shiftBackground();
        this.fetchBackground((dot - 1) & 7);
        if ((dot & 7) === 0) this.incrementX();
      }
      if (dot === 256) this.incrementY();
      if (dot === 257) {
        this.copyX();
        // ライン N で評価したスプライトはライン N+1 に表示される (OAM Y+1 遅延)
        if (visible) this.evaluateSprites(line);
        else this.spCount = 0; // プリレンダ後のライン0にスプライトは出ない
      }
      if (preRender && dot >= 280 && dot <= 304) this.copyY();
      // MMC3 スキャンラインカウンタ (A12 立ち上がり近似)
      if (dot === 260 && this.bus.mapper.scanline) this.bus.mapper.scanline();
    } else if (visible && dot >= 1 && dot <= 256) {
      // レンダリング無効時は背景色を出力
      const idx = this.palette[((this.v & 0x3FFF) >= 0x3F00) ? (this.v & 0x1F) : 0];
      const rgb = NES_PALETTE[idx & 0x3F];
      this.frame[line * 256 + (dot - 1)] =
        0xFF000000 | ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF);
    }

    // VBlank 開始
    if (line === 241 && dot === 1) {
      this.status |= 0x80;
      this.frameComplete = true;
      if (this.ctrl & 0x80) this.bus.cpu.triggerNMI();
    }
    // プリレンダラインでフラグクリア
    if (preRender && dot === 1) {
      this.status &= ~(0x80 | 0x40 | 0x20);
    }

    // ドット / スキャンライン更新
    this.dot++;
    if (this.dot > 340) {
      this.dot = 0;
      this.scanline++;
      if (this.scanline > 261) {
        this.scanline = 0;
        this.frameOdd = !this.frameOdd;
        // 奇数フレームはドット0スキップ (レンダリング有効時)
        if (this.frameOdd && rendering) this.dot = 1;
      }
    }
  }
}

function reverseByte(b) {
  b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
  b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
  return b;
}
