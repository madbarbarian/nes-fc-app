// ============================================================
// APU (RP2A03 内蔵音源) エミュレーション
// 参考: NESdev Wiki "APU" / "APU Mixer" / "APU Frame Counter"
//       https://www.nesdev.org/wiki/APU
//       https://www.nesdev.org/wiki/APU_Mixer (ルックアップテーブル式ミキサー)
// ============================================================

const LENGTH_TABLE = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];

const DUTY_TABLE = [
  [0, 1, 0, 0, 0, 0, 0, 0],  // 12.5%
  [0, 1, 1, 0, 0, 0, 0, 0],  // 25%
  [0, 1, 1, 1, 1, 0, 0, 0],  // 50%
  [1, 0, 0, 1, 1, 1, 1, 1],  // 25% 反転
];

const TRIANGLE_TABLE = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

const DMC_PERIODS = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

// ミキサー LUT (NESdev Wiki の式より)
const PULSE_TABLE = new Float32Array(31);
for (let i = 1; i < 31; i++) PULSE_TABLE[i] = 95.52 / (8128.0 / i + 100);
const TND_TABLE = new Float32Array(203);
for (let i = 1; i < 203; i++) TND_TABLE[i] = 163.67 / (24329.0 / i + 100);

class Envelope {
  constructor() { this.start = false; this.loop = false; this.constant = false;
    this.volume = 0; this.divider = 0; this.decay = 0; }
  clock() {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
    } else if (this.divider > 0) {
      this.divider--;
    } else {
      this.divider = this.volume;
      if (this.decay > 0) this.decay--;
      else if (this.loop) this.decay = 15;
    }
  }
  output() { return this.constant ? this.volume : this.decay; }
}

class Pulse {
  constructor(channel) {
    this.channel = channel; // 1 or 2 (スイープの挙動差)
    this.enabled = false;
    this.duty = 0; this.dutyPos = 0;
    this.timer = 0; this.timerPeriod = 0;
    this.lengthCounter = 0; this.lengthHalt = false;
    this.envelope = new Envelope();
    this.sweepEnabled = false; this.sweepPeriod = 0; this.sweepNegate = false;
    this.sweepShift = 0; this.sweepDivider = 0; this.sweepReload = false;
  }
  writeReg(reg, val) {
    switch (reg) {
      case 0:
        this.duty = (val >> 6) & 3;
        this.lengthHalt = (val & 0x20) !== 0;
        this.envelope.loop = this.lengthHalt;
        this.envelope.constant = (val & 0x10) !== 0;
        this.envelope.volume = val & 0x0F;
        break;
      case 1:
        this.sweepEnabled = (val & 0x80) !== 0;
        this.sweepPeriod = (val >> 4) & 7;
        this.sweepNegate = (val & 0x08) !== 0;
        this.sweepShift = val & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | val;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0xFF) | ((val & 7) << 8);
        if (this.enabled) this.lengthCounter = LENGTH_TABLE[val >> 3];
        this.envelope.start = true;
        this.dutyPos = 0;
        break;
    }
  }
  sweepTarget() {
    const delta = this.timerPeriod >> this.sweepShift;
    if (this.sweepNegate) {
      // パルス1は1の補数、パルス2は2の補数 (NESdev Wiki "APU Sweep")
      return this.timerPeriod - delta - (this.channel === 1 ? 1 : 0);
    }
    return this.timerPeriod + delta;
  }
  clockSweep() {
    if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0) {
      const target = this.sweepTarget();
      if (this.timerPeriod >= 8 && target <= 0x7FF && target >= 0) {
        this.timerPeriod = target;
      }
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }
  clockLength() {
    if (!this.lengthHalt && this.lengthCounter > 0) this.lengthCounter--;
  }
  clockTimer() { // APU サイクル (CPU 2サイクル) ごと
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      this.dutyPos = (this.dutyPos + 1) & 7;
    } else {
      this.timer--;
    }
  }
  output() {
    if (!this.enabled || this.lengthCounter === 0) return 0;
    if (this.timerPeriod < 8 || this.sweepTarget() > 0x7FF) return 0;
    if (DUTY_TABLE[this.duty][this.dutyPos] === 0) return 0;
    return this.envelope.output();
  }
}

class Triangle {
  constructor() {
    this.enabled = false;
    this.timer = 0; this.timerPeriod = 0;
    this.lengthCounter = 0; this.lengthHalt = false;
    this.linearCounter = 0; this.linearReload = 0; this.linearReloadFlag = false;
    this.seqPos = 0;
  }
  writeReg(reg, val) {
    switch (reg) {
      case 0:
        this.lengthHalt = (val & 0x80) !== 0;
        this.linearReload = val & 0x7F;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | val;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0xFF) | ((val & 7) << 8);
        if (this.enabled) this.lengthCounter = LENGTH_TABLE[val >> 3];
        this.linearReloadFlag = true;
        break;
    }
  }
  clockLinear() {
    if (this.linearReloadFlag) this.linearCounter = this.linearReload;
    else if (this.linearCounter > 0) this.linearCounter--;
    if (!this.lengthHalt) this.linearReloadFlag = false;
  }
  clockLength() {
    if (!this.lengthHalt && this.lengthCounter > 0) this.lengthCounter--;
  }
  clockTimer() { // CPU サイクルごと
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      if (this.lengthCounter > 0 && this.linearCounter > 0) {
        this.seqPos = (this.seqPos + 1) & 31;
      }
    } else {
      this.timer--;
    }
  }
  output() {
    if (!this.enabled || this.lengthCounter === 0 || this.linearCounter === 0) return TRIANGLE_TABLE[this.seqPos];
    // 超音波域 (period < 2) はポップ防止のため 7.5 相当を返す
    if (this.timerPeriod < 2) return 7;
    return TRIANGLE_TABLE[this.seqPos];
  }
}

class Noise {
  constructor() {
    this.enabled = false;
    this.timer = 0; this.timerPeriod = NOISE_PERIODS[0];
    this.lengthCounter = 0; this.lengthHalt = false;
    this.envelope = new Envelope();
    this.mode = false;
    this.shift = 1;
  }
  writeReg(reg, val) {
    switch (reg) {
      case 0:
        this.lengthHalt = (val & 0x20) !== 0;
        this.envelope.loop = this.lengthHalt;
        this.envelope.constant = (val & 0x10) !== 0;
        this.envelope.volume = val & 0x0F;
        break;
      case 2:
        this.mode = (val & 0x80) !== 0;
        this.timerPeriod = NOISE_PERIODS[val & 0x0F];
        break;
      case 3:
        if (this.enabled) this.lengthCounter = LENGTH_TABLE[val >> 3];
        this.envelope.start = true;
        break;
    }
  }
  clockLength() {
    if (!this.lengthHalt && this.lengthCounter > 0) this.lengthCounter--;
  }
  clockTimer() { // APU サイクルごと
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      const bit = this.mode ? 6 : 1;
      const feedback = (this.shift & 1) ^ ((this.shift >> bit) & 1);
      this.shift = (this.shift >> 1) | (feedback << 14);
    } else {
      this.timer--;
    }
  }
  output() {
    if (!this.enabled || this.lengthCounter === 0) return 0;
    if (this.shift & 1) return 0;
    return this.envelope.output();
  }
}

class DMC {
  constructor(bus) {
    this.bus = bus;
    this.enabled = false;
    this.irqEnable = false; this.loop = false;
    this.timer = 0; this.timerPeriod = DMC_PERIODS[0];
    this.output = 0;
    this.sampleAddr = 0xC000; this.sampleLen = 0;
    this.currentAddr = 0; this.bytesRemaining = 0;
    this.shiftReg = 0; this.bitsRemaining = 0; this.silence = true;
    this.buffer = -1; // -1 = 空
    this.irqFlag = false;
  }
  writeReg(reg, val) {
    switch (reg) {
      case 0:
        this.irqEnable = (val & 0x80) !== 0;
        if (!this.irqEnable) this.irqFlag = false;
        this.loop = (val & 0x40) !== 0;
        this.timerPeriod = DMC_PERIODS[val & 0x0F];
        break;
      case 1: this.output = val & 0x7F; break;
      case 2: this.sampleAddr = 0xC000 | (val << 6); break;
      case 3: this.sampleLen = (val << 4) | 1; break;
    }
  }
  restart() {
    this.currentAddr = this.sampleAddr;
    this.bytesRemaining = this.sampleLen;
  }
  fillBuffer() {
    if (this.buffer < 0 && this.bytesRemaining > 0) {
      // DMA 読み出し (CPU ストールは簡略化のため 4 サイクル固定)
      this.buffer = this.bus.cpuRead(this.currentAddr);
      this.bus.cpu.stall += 4;
      this.currentAddr = this.currentAddr === 0xFFFF ? 0x8000 : this.currentAddr + 1;
      this.bytesRemaining--;
      if (this.bytesRemaining === 0) {
        if (this.loop) this.restart();
        else if (this.irqEnable) this.irqFlag = true;
      }
    }
  }
  clockTimer() { // CPU サイクルごと
    if (this.timer > 0) { this.timer--; return; }
    this.timer = this.timerPeriod - 1;
    if (!this.silence) {
      if (this.shiftReg & 1) {
        if (this.output <= 125) this.output += 2;
      } else {
        if (this.output >= 2) this.output -= 2;
      }
    }
    this.shiftReg >>= 1;
    if (this.bitsRemaining > 0) this.bitsRemaining--;
    if (this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.buffer < 0) {
        this.silence = true;
      } else {
        this.silence = false;
        this.shiftReg = this.buffer;
        this.buffer = -1;
        this.fillBuffer();
      }
    }
  }
}

export class APU {
  constructor(bus, sampleRate = 44100) {
    this.bus = bus;
    this.pulse1 = new Pulse(1);
    this.pulse2 = new Pulse(2);
    this.triangle = new Triangle();
    this.noise = new Noise();
    this.dmc = new DMC(bus);

    // フレームカウンタ
    this.frameMode = 0;       // 0: 4ステップ, 1: 5ステップ
    this.frameIRQInhibit = false;
    this.frameIRQFlag = false;
    this.frameCounter = 0;    // CPU サイクル (×2 で半サイクル管理)
    this.apuCycle = 0;        // CPU 2サイクル = 1 APU サイクル

    // サンプリング
    this.sampleRate = sampleRate;
    this.cyclesPerSample = 1789773 / sampleRate; // NTSC CPU クロック
    this.sampleCounter = 0;
    this.samples = new Float32Array(8192); // リングバッファ
    this.sampleWrite = 0;
    this.sampleRead = 0;
  }

  writeRegister(addr, val) {
    switch (addr) {
      case 0x4000: case 0x4001: case 0x4002: case 0x4003:
        this.pulse1.writeReg(addr - 0x4000, val); break;
      case 0x4004: case 0x4005: case 0x4006: case 0x4007:
        this.pulse2.writeReg(addr - 0x4004, val); break;
      case 0x4008: case 0x400A: case 0x400B:
        this.triangle.writeReg(addr - 0x4008, val); break;
      case 0x400C: case 0x400E: case 0x400F:
        this.noise.writeReg(addr - 0x400C, val); break;
      case 0x4010: case 0x4011: case 0x4012: case 0x4013:
        this.dmc.writeReg(addr - 0x4010, val); break;
      case 0x4015:
        this.pulse1.enabled = (val & 0x01) !== 0;
        this.pulse2.enabled = (val & 0x02) !== 0;
        this.triangle.enabled = (val & 0x04) !== 0;
        this.noise.enabled = (val & 0x08) !== 0;
        if (!this.pulse1.enabled) this.pulse1.lengthCounter = 0;
        if (!this.pulse2.enabled) this.pulse2.lengthCounter = 0;
        if (!this.triangle.enabled) this.triangle.lengthCounter = 0;
        if (!this.noise.enabled) this.noise.lengthCounter = 0;
        this.dmc.enabled = (val & 0x10) !== 0;
        if (!this.dmc.enabled) {
          this.dmc.bytesRemaining = 0;
        } else if (this.dmc.bytesRemaining === 0) {
          this.dmc.restart();
          this.dmc.fillBuffer();
        }
        this.dmc.irqFlag = false;
        break;
      case 0x4017:
        this.frameMode = (val >> 7) & 1;
        this.frameIRQInhibit = (val & 0x40) !== 0;
        if (this.frameIRQInhibit) this.frameIRQFlag = false;
        this.frameCounter = 0;
        // 5ステップモードに設定すると即座に半/4分の1フレームクロック
        if (this.frameMode === 1) this.clockHalfFrame();
        break;
    }
  }

  readStatus() { // $4015
    let r = 0;
    if (this.pulse1.lengthCounter > 0) r |= 0x01;
    if (this.pulse2.lengthCounter > 0) r |= 0x02;
    if (this.triangle.lengthCounter > 0) r |= 0x04;
    if (this.noise.lengthCounter > 0) r |= 0x08;
    if (this.dmc.bytesRemaining > 0) r |= 0x10;
    if (this.frameIRQFlag) r |= 0x40;
    if (this.dmc.irqFlag) r |= 0x80;
    this.frameIRQFlag = false;
    return r;
  }

  clockQuarterFrame() {
    this.pulse1.envelope.clock();
    this.pulse2.envelope.clock();
    this.noise.envelope.clock();
    this.triangle.clockLinear();
  }

  clockHalfFrame() {
    this.clockQuarterFrame();
    this.pulse1.clockLength(); this.pulse1.clockSweep();
    this.pulse2.clockLength(); this.pulse2.clockSweep();
    this.triangle.clockLength();
    this.noise.clockLength();
  }

  irqPending() { return this.frameIRQFlag || this.dmc.irqFlag; }

  // CPU 1サイクルぶん進める
  step() {
    // フレームカウンタ (NTSC: 7457.5 CPU サイクル間隔 → 整数近似)
    this.frameCounter++;
    if (this.frameMode === 0) {
      switch (this.frameCounter) {
        case 7457: this.clockQuarterFrame(); break;
        case 14913: this.clockHalfFrame(); break;
        case 22371: this.clockQuarterFrame(); break;
        case 29829:
          this.clockHalfFrame();
          if (!this.frameIRQInhibit) this.frameIRQFlag = true;
          this.frameCounter = 0;
          break;
      }
    } else {
      switch (this.frameCounter) {
        case 7457: this.clockQuarterFrame(); break;
        case 14913: this.clockHalfFrame(); break;
        case 22371: this.clockQuarterFrame(); break;
        case 37281:
          this.clockHalfFrame();
          this.frameCounter = 0;
          break;
      }
    }

    // タイマー
    this.triangle.clockTimer();
    this.dmc.clockTimer();
    this.apuCycle ^= 1;
    if (this.apuCycle === 0) {
      this.pulse1.clockTimer();
      this.pulse2.clockTimer();
      this.noise.clockTimer();
    }

    // ダウンサンプリングして出力
    this.sampleCounter++;
    if (this.sampleCounter >= this.cyclesPerSample) {
      this.sampleCounter -= this.cyclesPerSample;
      this.pushSample(this.mix());
    }
  }

  mix() {
    const p = PULSE_TABLE[this.pulse1.output() + this.pulse2.output()];
    const t = TND_TABLE[3 * this.triangle.output() + 2 * this.noise.output() + this.dmc.output];
    return p + t;
  }

  pushSample(s) {
    const next = (this.sampleWrite + 1) & (this.samples.length - 1);
    if (next !== this.sampleRead) { // バッファフルなら捨てる
      this.samples[this.sampleWrite] = s;
      this.sampleWrite = next;
    }
  }

  // オーディオ出力側から呼ぶ: out に詰めた数を返す
  readSamples(out) {
    let n = 0;
    while (n < out.length && this.sampleRead !== this.sampleWrite) {
      out[n++] = this.samples[this.sampleRead];
      this.sampleRead = (this.sampleRead + 1) & (this.samples.length - 1);
    }
    return n;
  }

  availableSamples() {
    return (this.sampleWrite - this.sampleRead) & (this.samples.length - 1);
  }
}
