// ============================================================
// 内蔵デモ ROM ジェネレータ
// ROM ファイルなしでエミュレータの動作確認ができる、
// ハンドアセンブルした最小の NROM プログラムを生成する。
// (スクロールするカラフルな市松模様 + 動くスプライト)
// ============================================================

class Asm {
  constructor(origin) {
    this.origin = origin;
    this.bytes = [];
    this.labels = {};
    this.patches = []; // {pos, label, kind:'abs'|'rel'}
  }
  get pc() { return this.origin + this.bytes.length; }
  emit(...bs) { for (const b of bs) this.bytes.push(b & 0xFF); }
  label(name) { this.labels[name] = this.pc; }
  // 絶対アドレス参照 (2バイトのプレースホルダ)
  abs(label) { this.patches.push({ pos: this.bytes.length, label, kind: 'abs' }); this.emit(0, 0); }
  // 相対分岐 (1バイト)
  rel(label) { this.patches.push({ pos: this.bytes.length, label, kind: 'rel' }); this.emit(0); }
  assemble() {
    for (const p of this.patches) {
      const target = this.labels[p.label];
      if (target === undefined) throw new Error(`未定義ラベル: ${p.label}`);
      if (p.kind === 'abs') {
        this.bytes[p.pos] = target & 0xFF;
        this.bytes[p.pos + 1] = (target >> 8) & 0xFF;
      } else {
        const from = this.origin + p.pos + 1;
        const off = target - from;
        if (off < -128 || off > 127) throw new Error(`分岐が届きません: ${p.label}`);
        this.bytes[p.pos] = off & 0xFF;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}

export function buildDemoROM() {
  const a = new Asm(0x8000);

  // ---- リセットルーチン ----
  a.label('reset');
  a.emit(0x78);             // SEI
  a.emit(0xD8);             // CLD
  a.emit(0xA2, 0xFF);       // LDX #$FF
  a.emit(0x9A);             // TXS
  a.emit(0xA9, 0x00);       // LDA #$00
  a.emit(0x8D, 0x00, 0x20); // STA $2000 (NMI 無効)
  a.emit(0x8D, 0x01, 0x20); // STA $2001 (描画無効)

  // VBlank を2回待つ
  a.label('wait1');
  a.emit(0x2C, 0x02, 0x20); // BIT $2002
  a.emit(0x10); a.rel('wait1'); // BPL wait1
  a.label('wait2');
  a.emit(0x2C, 0x02, 0x20);
  a.emit(0x10); a.rel('wait2');

  // パレット書き込み ($3F00-$3F1F)
  a.emit(0xA9, 0x3F);       // LDA #$3F
  a.emit(0x8D, 0x06, 0x20); // STA $2006
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA2, 0x00);       // LDX #0
  a.label('palLoop');
  a.emit(0xBD); a.abs('palette'); // LDA palette,X
  a.emit(0x8D, 0x07, 0x20); // STA $2007
  a.emit(0xE8);             // INX
  a.emit(0xE0, 0x20);       // CPX #$20
  a.emit(0xD0); a.rel('palLoop'); // BNE

  // ネームテーブル $2000 を埋める (960タイル + 64属性 = 1024バイト)
  a.emit(0xA9, 0x20);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA2, 0x00);       // LDX #0
  a.emit(0xA0, 0x04);       // LDY #4 (256×4 = 1024)
  a.label('ntLoop');
  a.emit(0x8A);             // TXA
  a.emit(0x4A);             // LSR (2ドットごとにタイル変化)
  a.emit(0x29, 0x03);       // AND #$03
  a.emit(0x8D, 0x07, 0x20); // STA $2007
  a.emit(0xE8);             // INX
  a.emit(0xD0); a.rel('ntLoop'); // BNE (X が 0 に戻るまで)
  a.emit(0x88);             // DEY
  a.emit(0xD0); a.rel('ntLoop'); // BNE

  // スプライト (OAM) を RAM $0200 に用意
  a.emit(0xA9, 0x77);       // LDA #$77 (Y)
  a.emit(0x85, 0x10);       // STA $10 (スプライトY作業用)
  a.emit(0xA9, 0x00);
  a.emit(0x85, 0x00);       // STA $00 (スクロールカウンタ)

  // スクロールリセット
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x05, 0x20); // STA $2005
  a.emit(0x8D, 0x05, 0x20); // STA $2005

  // NMI + 描画有効化
  a.emit(0xA9, 0x80);       // LDA #%10000000 (NMI on, BG パターンテーブル $0000)
  a.emit(0x8D, 0x00, 0x20); // STA $2000
  a.emit(0xA9, 0x1E);       // LDA #%00011110 (BG+SP 表示)
  a.emit(0x8D, 0x01, 0x20); // STA $2001

  a.label('forever');
  a.emit(0x4C); a.abs('forever'); // JMP forever

  // ---- NMI ハンドラ: スクロール & スプライト移動 ----
  a.label('nmi');
  a.emit(0x48);             // PHA
  a.emit(0x8A); a.emit(0x48); // TXA / PHA

  // OAM 更新: スプライト0 を $0200 に書いて DMA
  a.emit(0xE6, 0x00);       // INC $00 (フレームカウンタ)
  a.emit(0xA5, 0x00);       // LDA $00
  a.emit(0x8D, 0x00, 0x02); //   Y 座標 = counter → STA $0200
  a.emit(0xA9, 0x03);       // LDA #3 (タイル番号)
  a.emit(0x8D, 0x01, 0x02); // STA $0201
  a.emit(0xA9, 0x00);       // LDA #0 (属性)
  a.emit(0x8D, 0x02, 0x02); // STA $0202
  a.emit(0xA5, 0x00);       // LDA $00
  a.emit(0x0A);             // ASL (X は2倍速で移動)
  a.emit(0x8D, 0x03, 0x02); // STA $0203
  a.emit(0xA9, 0x02);       // LDA #$02
  a.emit(0x8D, 0x14, 0x40); // STA $4014 (OAM DMA)

  // スクロール設定
  a.emit(0xA5, 0x00);       // LDA $00
  a.emit(0x8D, 0x05, 0x20); // STA $2005 (X スクロール)
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x05, 0x20); // STA $2005 (Y スクロール)

  a.emit(0x68); a.emit(0xAA); // PLA / TAX
  a.emit(0x68);             // PLA
  a.emit(0x40);             // RTI

  a.label('irq');
  a.emit(0x40);             // RTI

  // ---- パレットデータ ----
  a.label('palette');
  // BG: 紺ベースに青/水色/白、赤系、緑系、黄系
  a.emit(0x0F, 0x11, 0x21, 0x30,  0x0F, 0x16, 0x26, 0x36,
         0x0F, 0x1A, 0x2A, 0x3A,  0x0F, 0x18, 0x28, 0x38);
  // SP: 白/赤系ほか
  a.emit(0x0F, 0x30, 0x27, 0x16,  0x0F, 0x2C, 0x3C, 0x30,
         0x0F, 0x24, 0x34, 0x30,  0x0F, 0x29, 0x39, 0x30);

  const code = a.assemble();
  const reset = a.labels['reset'], nmi = a.labels['nmi'], irq = a.labels['irq'];

  // ---- PRG 16KB ----
  const prg = new Uint8Array(0x4000);
  prg.set(code, 0);
  // ベクタ ($FFFA/FFFC/FFFE は 16KB ミラーの末尾)
  prg[0x3FFA] = nmi & 0xFF; prg[0x3FFB] = nmi >> 8;
  prg[0x3FFC] = reset & 0xFF; prg[0x3FFD] = reset >> 8;
  prg[0x3FFE] = irq & 0xFF; prg[0x3FFF] = irq >> 8;

  // ---- CHR 8KB: 4種のタイルを生成 ----
  const chr = new Uint8Array(0x2000);
  const setTile = (index, fn) => {
    for (let y = 0; y < 8; y++) {
      let low = 0, high = 0;
      for (let x = 0; x < 8; x++) {
        const c = fn(x, y) & 3;
        low |= (c & 1) << (7 - x);
        high |= ((c >> 1) & 1) << (7 - x);
      }
      chr[index * 16 + y] = low;
      chr[index * 16 + y + 8] = high;
    }
  };
  setTile(0, (x, y) => ((x >> 2) + (y >> 2)) & 1 ? 1 : 0);          // 市松
  setTile(1, (x, y) => ((x + y) & 4) ? 2 : 3);                      // 斜めストライプ
  setTile(2, (x, y) => (x === 0 || y === 0 || x === 7 || y === 7) ? 1 : 2); // 枠
  setTile(3, (x, y) => {                                            // 丸 (スプライト用)
    const dx = x - 3.5, dy = y - 3.5;
    const d = dx * dx + dy * dy;
    return d < 6 ? 1 : (d < 12 ? 2 : 0);
  });

  // ---- iNES ファイル組み立て ----
  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set([0x4E, 0x45, 0x53, 0x1A, 1, 1, 0x00, 0x00], 0); // NROM, 水平ミラー
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}
