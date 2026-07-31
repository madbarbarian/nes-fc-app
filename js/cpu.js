// ============================================================
// 6502 (RP2A03) CPU エミュレーション
// 参考: NESdev Wiki "CPU" / "6502 instructions"
//       https://www.nesdev.org/wiki/CPU
// ============================================================

// ステータスフラグ
const FC = 0x01, FZ = 0x02, FI = 0x04, FD = 0x08,
      FB = 0x10, FU = 0x20, FV = 0x40, FN = 0x80;

// アドレッシングモード
const IMP = 0, ACC = 1, IMM = 2, ZP = 3, ZPX = 4, ZPY = 5,
      ABS = 6, ABX = 7, ABY = 8, IND = 9, IZX = 10, IZY = 11, REL = 12;

// 命令テーブル: opcode -> [ニーモニック, モード, 基本サイクル, ページ跨ぎ+1]
const OP = new Array(256).fill(null);
function o(code, name, mode, cyc, pg = 0) { OP[code] = [name, mode, cyc, pg]; }

// --- 公式命令 ---
o(0x69,'ADC',IMM,2); o(0x65,'ADC',ZP,3); o(0x75,'ADC',ZPX,4); o(0x6D,'ADC',ABS,4);
o(0x7D,'ADC',ABX,4,1); o(0x79,'ADC',ABY,4,1); o(0x61,'ADC',IZX,6); o(0x71,'ADC',IZY,5,1);
o(0x29,'AND',IMM,2); o(0x25,'AND',ZP,3); o(0x35,'AND',ZPX,4); o(0x2D,'AND',ABS,4);
o(0x3D,'AND',ABX,4,1); o(0x39,'AND',ABY,4,1); o(0x21,'AND',IZX,6); o(0x31,'AND',IZY,5,1);
o(0x0A,'ASL',ACC,2); o(0x06,'ASL',ZP,5); o(0x16,'ASL',ZPX,6); o(0x0E,'ASL',ABS,6); o(0x1E,'ASL',ABX,7);
o(0x90,'BCC',REL,2); o(0xB0,'BCS',REL,2); o(0xF0,'BEQ',REL,2); o(0x30,'BMI',REL,2);
o(0xD0,'BNE',REL,2); o(0x10,'BPL',REL,2); o(0x50,'BVC',REL,2); o(0x70,'BVS',REL,2);
o(0x24,'BIT',ZP,3); o(0x2C,'BIT',ABS,4);
o(0x00,'BRK',IMP,7);
o(0x18,'CLC',IMP,2); o(0xD8,'CLD',IMP,2); o(0x58,'CLI',IMP,2); o(0xB8,'CLV',IMP,2);
o(0xC9,'CMP',IMM,2); o(0xC5,'CMP',ZP,3); o(0xD5,'CMP',ZPX,4); o(0xCD,'CMP',ABS,4);
o(0xDD,'CMP',ABX,4,1); o(0xD9,'CMP',ABY,4,1); o(0xC1,'CMP',IZX,6); o(0xD1,'CMP',IZY,5,1);
o(0xE0,'CPX',IMM,2); o(0xE4,'CPX',ZP,3); o(0xEC,'CPX',ABS,4);
o(0xC0,'CPY',IMM,2); o(0xC4,'CPY',ZP,3); o(0xCC,'CPY',ABS,4);
o(0xC6,'DEC',ZP,5); o(0xD6,'DEC',ZPX,6); o(0xCE,'DEC',ABS,6); o(0xDE,'DEC',ABX,7);
o(0xCA,'DEX',IMP,2); o(0x88,'DEY',IMP,2);
o(0x49,'EOR',IMM,2); o(0x45,'EOR',ZP,3); o(0x55,'EOR',ZPX,4); o(0x4D,'EOR',ABS,4);
o(0x5D,'EOR',ABX,4,1); o(0x59,'EOR',ABY,4,1); o(0x41,'EOR',IZX,6); o(0x51,'EOR',IZY,5,1);
o(0xE6,'INC',ZP,5); o(0xF6,'INC',ZPX,6); o(0xEE,'INC',ABS,6); o(0xFE,'INC',ABX,7);
o(0xE8,'INX',IMP,2); o(0xC8,'INY',IMP,2);
o(0x4C,'JMP',ABS,3); o(0x6C,'JMP',IND,5);
o(0x20,'JSR',ABS,6);
o(0xA9,'LDA',IMM,2); o(0xA5,'LDA',ZP,3); o(0xB5,'LDA',ZPX,4); o(0xAD,'LDA',ABS,4);
o(0xBD,'LDA',ABX,4,1); o(0xB9,'LDA',ABY,4,1); o(0xA1,'LDA',IZX,6); o(0xB1,'LDA',IZY,5,1);
o(0xA2,'LDX',IMM,2); o(0xA6,'LDX',ZP,3); o(0xB6,'LDX',ZPY,4); o(0xAE,'LDX',ABS,4); o(0xBE,'LDX',ABY,4,1);
o(0xA0,'LDY',IMM,2); o(0xA4,'LDY',ZP,3); o(0xB4,'LDY',ZPX,4); o(0xAC,'LDY',ABS,4); o(0xBC,'LDY',ABX,4,1);
o(0x4A,'LSR',ACC,2); o(0x46,'LSR',ZP,5); o(0x56,'LSR',ZPX,6); o(0x4E,'LSR',ABS,6); o(0x5E,'LSR',ABX,7);
o(0xEA,'NOP',IMP,2);
o(0x09,'ORA',IMM,2); o(0x05,'ORA',ZP,3); o(0x15,'ORA',ZPX,4); o(0x0D,'ORA',ABS,4);
o(0x1D,'ORA',ABX,4,1); o(0x19,'ORA',ABY,4,1); o(0x01,'ORA',IZX,6); o(0x11,'ORA',IZY,5,1);
o(0x48,'PHA',IMP,3); o(0x08,'PHP',IMP,3); o(0x68,'PLA',IMP,4); o(0x28,'PLP',IMP,4);
o(0x2A,'ROL',ACC,2); o(0x26,'ROL',ZP,5); o(0x36,'ROL',ZPX,6); o(0x2E,'ROL',ABS,6); o(0x3E,'ROL',ABX,7);
o(0x6A,'ROR',ACC,2); o(0x66,'ROR',ZP,5); o(0x76,'ROR',ZPX,6); o(0x6E,'ROR',ABS,6); o(0x7E,'ROR',ABX,7);
o(0x40,'RTI',IMP,6); o(0x60,'RTS',IMP,6);
o(0xE9,'SBC',IMM,2); o(0xE5,'SBC',ZP,3); o(0xF5,'SBC',ZPX,4); o(0xED,'SBC',ABS,4);
o(0xFD,'SBC',ABX,4,1); o(0xF9,'SBC',ABY,4,1); o(0xE1,'SBC',IZX,6); o(0xF1,'SBC',IZY,5,1);
o(0x38,'SEC',IMP,2); o(0xF8,'SED',IMP,2); o(0x78,'SEI',IMP,2);
o(0x85,'STA',ZP,3); o(0x95,'STA',ZPX,4); o(0x8D,'STA',ABS,4); o(0x9D,'STA',ABX,5);
o(0x99,'STA',ABY,5); o(0x81,'STA',IZX,6); o(0x91,'STA',IZY,6);
o(0x86,'STX',ZP,3); o(0x96,'STX',ZPY,4); o(0x8E,'STX',ABS,4);
o(0x84,'STY',ZP,3); o(0x94,'STY',ZPX,4); o(0x8C,'STY',ABS,4);
o(0xAA,'TAX',IMP,2); o(0xA8,'TAY',IMP,2); o(0xBA,'TSX',IMP,2);
o(0x8A,'TXA',IMP,2); o(0x9A,'TXS',IMP,2); o(0x98,'TYA',IMP,2);

// --- 非公式命令 (実ゲームで使用されるもの) ---
for (const c of [0x1A,0x3A,0x5A,0x7A,0xDA,0xFA]) o(c,'NOP',IMP,2);
for (const c of [0x80,0x82,0x89,0xC2,0xE2]) o(c,'NOP',IMM,2);
for (const c of [0x04,0x44,0x64]) o(c,'NOP',ZP,3);
for (const c of [0x14,0x34,0x54,0x74,0xD4,0xF4]) o(c,'NOP',ZPX,4);
o(0x0C,'NOP',ABS,4);
for (const c of [0x1C,0x3C,0x5C,0x7C,0xDC,0xFC]) o(c,'NOP',ABX,4,1);
o(0xEB,'SBC',IMM,2);
o(0xA7,'LAX',ZP,3); o(0xB7,'LAX',ZPY,4); o(0xAF,'LAX',ABS,4);
o(0xBF,'LAX',ABY,4,1); o(0xA3,'LAX',IZX,6); o(0xB3,'LAX',IZY,5,1);
o(0x87,'SAX',ZP,3); o(0x97,'SAX',ZPY,4); o(0x8F,'SAX',ABS,4); o(0x83,'SAX',IZX,6);
o(0xC7,'DCP',ZP,5); o(0xD7,'DCP',ZPX,6); o(0xCF,'DCP',ABS,6); o(0xDF,'DCP',ABX,7);
o(0xDB,'DCP',ABY,7); o(0xC3,'DCP',IZX,8); o(0xD3,'DCP',IZY,8);
o(0xE7,'ISB',ZP,5); o(0xF7,'ISB',ZPX,6); o(0xEF,'ISB',ABS,6); o(0xFF,'ISB',ABX,7);
o(0xFB,'ISB',ABY,7); o(0xE3,'ISB',IZX,8); o(0xF3,'ISB',IZY,8);
o(0x07,'SLO',ZP,5); o(0x17,'SLO',ZPX,6); o(0x0F,'SLO',ABS,6); o(0x1F,'SLO',ABX,7);
o(0x1B,'SLO',ABY,7); o(0x03,'SLO',IZX,8); o(0x13,'SLO',IZY,8);
o(0x27,'RLA',ZP,5); o(0x37,'RLA',ZPX,6); o(0x2F,'RLA',ABS,6); o(0x3F,'RLA',ABX,7);
o(0x3B,'RLA',ABY,7); o(0x23,'RLA',IZX,8); o(0x33,'RLA',IZY,8);
o(0x47,'SRE',ZP,5); o(0x57,'SRE',ZPX,6); o(0x4F,'SRE',ABS,6); o(0x5F,'SRE',ABX,7);
o(0x5B,'SRE',ABY,7); o(0x43,'SRE',IZX,8); o(0x53,'SRE',IZY,8);
o(0x67,'RRA',ZP,5); o(0x77,'RRA',ZPX,6); o(0x6F,'RRA',ABS,6); o(0x7F,'RRA',ABX,7);
o(0x7B,'RRA',ABY,7); o(0x63,'RRA',IZX,8); o(0x73,'RRA',IZY,8);

export class CPU {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.x = 0; this.y = 0;
    this.sp = 0xFD; this.pc = 0;
    this.p = FI | FU;
    this.stall = 0;         // OAM DMA 等のストールサイクル
    this.nmiPending = false;
    this.irqLine = false;   // レベルトリガ IRQ (APU/マッパー)
  }

  reset() {
    this.sp = (this.sp - 3) & 0xFF;
    this.p |= FI;
    this.pc = this.read16(0xFFFC);
    this.nmiPending = false;
  }

  powerOn() {
    this.a = this.x = this.y = 0;
    this.sp = 0xFD;
    this.p = FI | FU;
    this.pc = this.read16(0xFFFC);
  }

  read(a) { return this.bus.cpuRead(a); }
  write(a, v) { this.bus.cpuWrite(a, v); }
  read16(a) { return this.read(a) | (this.read((a + 1) & 0xFFFF) << 8); }
  // 6502 バグ: ページ境界を跨ぐ間接参照は下位バイトのみ繰り上がる
  read16bug(a) {
    const lo = this.read(a);
    const hi = this.read((a & 0xFF00) | ((a + 1) & 0xFF));
    return lo | (hi << 8);
  }

  push(v) { this.write(0x100 | this.sp, v & 0xFF); this.sp = (this.sp - 1) & 0xFF; }
  pop() { this.sp = (this.sp + 1) & 0xFF; return this.read(0x100 | this.sp); }
  push16(v) { this.push(v >> 8); this.push(v & 0xFF); }
  pop16() { const lo = this.pop(); return lo | (this.pop() << 8); }

  setZN(v) {
    v &= 0xFF;
    this.p = (this.p & ~(FZ | FN)) | (v === 0 ? FZ : 0) | (v & 0x80);
    return v;
  }

  triggerNMI() { this.nmiPending = true; }

  // 1命令実行し、消費サイクル数を返す
  step() {
    if (this.stall > 0) { const s = this.stall; this.stall = 0; return s; }

    if (this.nmiPending) {
      this.nmiPending = false;
      this.push16(this.pc);
      this.push((this.p & ~FB) | FU);
      this.p |= FI;
      this.pc = this.read16(0xFFFA);
      return 7;
    }
    if (this.irqLine && !(this.p & FI)) {
      this.push16(this.pc);
      this.push((this.p & ~FB) | FU);
      this.p |= FI;
      this.pc = this.read16(0xFFFE);
      return 7;
    }

    const code = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    const entry = OP[code] || ['NOP', IMP, 2, 0];
    const [name, mode, baseCyc, pgExtra] = entry;

    // アドレス解決
    let addr = 0, crossed = false;
    switch (mode) {
      case IMP: case ACC: break;
      case IMM: addr = this.pc; this.pc = (this.pc + 1) & 0xFFFF; break;
      case ZP:  addr = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; break;
      case ZPX: addr = (this.read(this.pc) + this.x) & 0xFF; this.pc = (this.pc + 1) & 0xFFFF; break;
      case ZPY: addr = (this.read(this.pc) + this.y) & 0xFF; this.pc = (this.pc + 1) & 0xFFFF; break;
      case ABS: addr = this.read16(this.pc); this.pc = (this.pc + 2) & 0xFFFF; break;
      case ABX: {
        const base = this.read16(this.pc); this.pc = (this.pc + 2) & 0xFFFF;
        addr = (base + this.x) & 0xFFFF;
        crossed = (base & 0xFF00) !== (addr & 0xFF00);
        break;
      }
      case ABY: {
        const base = this.read16(this.pc); this.pc = (this.pc + 2) & 0xFFFF;
        addr = (base + this.y) & 0xFFFF;
        crossed = (base & 0xFF00) !== (addr & 0xFF00);
        break;
      }
      case IND: addr = this.read16bug(this.read16(this.pc)); this.pc = (this.pc + 2) & 0xFFFF; break;
      case IZX: {
        const zp = (this.read(this.pc) + this.x) & 0xFF; this.pc = (this.pc + 1) & 0xFFFF;
        addr = this.read16bug(zp);
        break;
      }
      case IZY: {
        const zp = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
        const base = this.read16bug(zp);
        addr = (base + this.y) & 0xFFFF;
        crossed = (base & 0xFF00) !== (addr & 0xFF00);
        break;
      }
      case REL: {
        let off = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
        if (off & 0x80) off -= 0x100;
        addr = (this.pc + off) & 0xFFFF;
        break;
      }
    }

    let cycles = baseCyc + (pgExtra && crossed ? 1 : 0);

    const branch = (cond) => {
      if (cond) {
        cycles += ((this.pc & 0xFF00) !== (addr & 0xFF00)) ? 2 : 1;
        this.pc = addr;
      }
    };
    const adc = (v) => {
      const sum = this.a + v + (this.p & FC ? 1 : 0);
      this.p = (this.p & ~(FC | FV)) |
               (sum > 0xFF ? FC : 0) |
               ((~(this.a ^ v) & (this.a ^ sum) & 0x80) ? FV : 0);
      this.a = this.setZN(sum);
    };
    const cmp = (reg, v) => {
      const d = (reg - v) & 0x1FF;
      this.p = (this.p & ~FC) | (reg >= v ? FC : 0);
      this.setZN(d & 0xFF);
    };

    switch (name) {
      case 'ADC': adc(this.read(addr)); break;
      case 'SBC': adc(this.read(addr) ^ 0xFF); break;
      case 'AND': this.a = this.setZN(this.a & this.read(addr)); break;
      case 'ORA': this.a = this.setZN(this.a | this.read(addr)); break;
      case 'EOR': this.a = this.setZN(this.a ^ this.read(addr)); break;
      case 'ASL': {
        if (mode === ACC) {
          this.p = (this.p & ~FC) | (this.a & 0x80 ? FC : 0);
          this.a = this.setZN((this.a << 1) & 0xFF);
        } else {
          let v = this.read(addr);
          this.p = (this.p & ~FC) | (v & 0x80 ? FC : 0);
          v = this.setZN((v << 1) & 0xFF);
          this.write(addr, v);
        }
        break;
      }
      case 'LSR': {
        if (mode === ACC) {
          this.p = (this.p & ~FC) | (this.a & 1 ? FC : 0);
          this.a = this.setZN(this.a >> 1);
        } else {
          let v = this.read(addr);
          this.p = (this.p & ~FC) | (v & 1 ? FC : 0);
          v = this.setZN(v >> 1);
          this.write(addr, v);
        }
        break;
      }
      case 'ROL': {
        const c = this.p & FC ? 1 : 0;
        if (mode === ACC) {
          this.p = (this.p & ~FC) | (this.a & 0x80 ? FC : 0);
          this.a = this.setZN(((this.a << 1) | c) & 0xFF);
        } else {
          let v = this.read(addr);
          this.p = (this.p & ~FC) | (v & 0x80 ? FC : 0);
          v = this.setZN(((v << 1) | c) & 0xFF);
          this.write(addr, v);
        }
        break;
      }
      case 'ROR': {
        const c = this.p & FC ? 0x80 : 0;
        if (mode === ACC) {
          this.p = (this.p & ~FC) | (this.a & 1 ? FC : 0);
          this.a = this.setZN((this.a >> 1) | c);
        } else {
          let v = this.read(addr);
          this.p = (this.p & ~FC) | (v & 1 ? FC : 0);
          v = this.setZN((v >> 1) | c);
          this.write(addr, v);
        }
        break;
      }
      case 'BCC': branch(!(this.p & FC)); break;
      case 'BCS': branch(!!(this.p & FC)); break;
      case 'BNE': branch(!(this.p & FZ)); break;
      case 'BEQ': branch(!!(this.p & FZ)); break;
      case 'BPL': branch(!(this.p & FN)); break;
      case 'BMI': branch(!!(this.p & FN)); break;
      case 'BVC': branch(!(this.p & FV)); break;
      case 'BVS': branch(!!(this.p & FV)); break;
      case 'BIT': {
        const v = this.read(addr);
        this.p = (this.p & ~(FZ | FV | FN)) |
                 ((this.a & v) === 0 ? FZ : 0) | (v & (FV | FN));
        break;
      }
      case 'BRK':
        this.pc = (this.pc + 1) & 0xFFFF;
        this.push16(this.pc);
        this.push(this.p | FB | FU);
        this.p |= FI;
        this.pc = this.read16(0xFFFE);
        break;
      case 'CLC': this.p &= ~FC; break;
      case 'SEC': this.p |= FC; break;
      case 'CLD': this.p &= ~FD; break;
      case 'SED': this.p |= FD; break;
      case 'CLI': this.p &= ~FI; break;
      case 'SEI': this.p |= FI; break;
      case 'CLV': this.p &= ~FV; break;
      case 'CMP': cmp(this.a, this.read(addr)); break;
      case 'CPX': cmp(this.x, this.read(addr)); break;
      case 'CPY': cmp(this.y, this.read(addr)); break;
      case 'DEC': { const v = this.setZN((this.read(addr) - 1) & 0xFF); this.write(addr, v); break; }
      case 'INC': { const v = this.setZN((this.read(addr) + 1) & 0xFF); this.write(addr, v); break; }
      case 'DEX': this.x = this.setZN((this.x - 1) & 0xFF); break;
      case 'DEY': this.y = this.setZN((this.y - 1) & 0xFF); break;
      case 'INX': this.x = this.setZN((this.x + 1) & 0xFF); break;
      case 'INY': this.y = this.setZN((this.y + 1) & 0xFF); break;
      case 'JMP': this.pc = addr; break;
      case 'JSR': this.push16((this.pc - 1) & 0xFFFF); this.pc = addr; break;
      case 'RTS': this.pc = (this.pop16() + 1) & 0xFFFF; break;
      case 'RTI': this.p = (this.pop() & ~FB) | FU; this.pc = this.pop16(); break;
      case 'LDA': this.a = this.setZN(this.read(addr)); break;
      case 'LDX': this.x = this.setZN(this.read(addr)); break;
      case 'LDY': this.y = this.setZN(this.read(addr)); break;
      case 'STA': this.write(addr, this.a); break;
      case 'STX': this.write(addr, this.x); break;
      case 'STY': this.write(addr, this.y); break;
      case 'TAX': this.x = this.setZN(this.a); break;
      case 'TAY': this.y = this.setZN(this.a); break;
      case 'TXA': this.a = this.setZN(this.x); break;
      case 'TYA': this.a = this.setZN(this.y); break;
      case 'TSX': this.x = this.setZN(this.sp); break;
      case 'TXS': this.sp = this.x; break;
      case 'PHA': this.push(this.a); break;
      case 'PLA': this.a = this.setZN(this.pop()); break;
      case 'PHP': this.push(this.p | FB | FU); break;
      case 'PLP': this.p = (this.pop() & ~FB) | FU; break;
      case 'NOP': if (mode !== IMP && mode !== ACC) this.read(addr); break;
      // --- 非公式 ---
      case 'LAX': this.a = this.x = this.setZN(this.read(addr)); break;
      case 'SAX': this.write(addr, this.a & this.x); break;
      case 'DCP': {
        const v = (this.read(addr) - 1) & 0xFF;
        this.write(addr, v);
        cmp(this.a, v);
        break;
      }
      case 'ISB': {
        const v = (this.read(addr) + 1) & 0xFF;
        this.write(addr, v);
        adc(v ^ 0xFF);
        break;
      }
      case 'SLO': {
        let v = this.read(addr);
        this.p = (this.p & ~FC) | (v & 0x80 ? FC : 0);
        v = (v << 1) & 0xFF;
        this.write(addr, v);
        this.a = this.setZN(this.a | v);
        break;
      }
      case 'RLA': {
        const c = this.p & FC ? 1 : 0;
        let v = this.read(addr);
        this.p = (this.p & ~FC) | (v & 0x80 ? FC : 0);
        v = ((v << 1) | c) & 0xFF;
        this.write(addr, v);
        this.a = this.setZN(this.a & v);
        break;
      }
      case 'SRE': {
        let v = this.read(addr);
        this.p = (this.p & ~FC) | (v & 1 ? FC : 0);
        v >>= 1;
        this.write(addr, v);
        this.a = this.setZN(this.a ^ v);
        break;
      }
      case 'RRA': {
        const c = this.p & FC ? 0x80 : 0;
        let v = this.read(addr);
        this.p = (this.p & ~FC) | (v & 1 ? FC : 0);
        v = (v >> 1) | c;
        this.write(addr, v);
        adc(v);
        break;
      }
    }
    return cycles;
  }
}
