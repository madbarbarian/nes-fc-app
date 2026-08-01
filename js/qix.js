// ============================================================
// 内蔵ゲーム「QIX風 陣取りゲーム」— ハンドアセンブル NROM ROM
//
// ルール:
//   ・十字キーで自機(◆)を移動。青い壁の上は自由に歩ける
//   ・黒い空き地に踏み出すと黄色い線(軌跡)を引く
//   ・壁まで戻って囲いを閉じると、敵(●)がいない側が塗られる
//   ・敵が軌跡に触れるとミス → 軌跡消去 & スタート位置へ
//   ・画面上部のバーが目盛り(▎=75%)に達したら勝利! START で再挑戦
//
// メモリマップ:
//   $0000-$1F  変数 / $0200-$02FF OAM バッファ
//   $0300-$06BF プレイフィールド 32×30 (0=空 1=陣地 2=軌跡 3=充填作業用)
// ============================================================

import { Asm } from './demo.js';

// ゼロページ変数
const PAD = 0x00, PX = 0x02, PY = 0x03,
      QXP = 0x04, QYP = 0x05, DQX = 0x06, DQY = 0x07,
      MODE = 0x08,        // 0=プレイ 1=充填 2=再描画 3=ミス 4=勝利
      TRAILF = 0x09, MOVEDLY = 0x0A,
      CLM_LO = 0x0B, CLM_HI = 0x0C,
      CHANGED = 0x0D, DRAWROW = 0x0E,
      T0 = 0x0F,
      PTRA = 0x10, PTRB = 0x12, PTRC = 0x14,
      WINF = 0x16, WINCNT = 0x17,
      DIRTY_R = 0x18, DIRTY_C = 0x19, DIRTY_F = 0x1A,
      TTY = 0x1B, TTX = 0x1C;

const START_PX = 16, START_PY = 28;
const WIN_LO = 0x49, WIN_HI = 0x02;   // 585 セル = 780 の 75%

export function buildQixROM() {
  const a = new Asm(0x8000);

  // ptrA = fieldRow[X] を設定 (X は行番号)
  const setPtrA = () => {
    a.emit(0xBD); a.abs('fRowLo'); // LDA fRowLo,X
    a.emit(0x85, PTRA);
    a.emit(0xBD); a.abs('fRowHi');
    a.emit(0x85, PTRA + 1);
  };

  // ================= リセット =================
  a.label('reset');
  a.emit(0x78);             // SEI
  a.emit(0xD8);             // CLD
  a.emit(0xA2, 0xFF);       // LDX #$FF
  a.emit(0x9A);             // TXS
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x00, 0x20); // STA $2000 (NMI 無効)
  a.emit(0x8D, 0x01, 0x20); // STA $2001 (描画無効)

  a.label('rWait1');
  a.emit(0x2C, 0x02, 0x20); // BIT $2002
  a.emit(0x10); a.rel('rWait1');
  a.label('rWait2');
  a.emit(0x2C, 0x02, 0x20);
  a.emit(0x10); a.rel('rWait2');

  // --- ゼロページ変数クリア ($00-$1F) ---
  a.emit(0xA9, 0x00);       // LDA #0
  a.emit(0xA2, 0x1F);       // LDX #$1F
  a.label('zpClr');
  a.emit(0x95, 0x00);       // STA $00,X
  a.emit(0xCA);             // DEX
  a.emit(0x10); a.rel('zpClr'); // BPL

  // --- OAM バッファを $F0 (画面外) で初期化 ---
  a.emit(0xA9, 0xF0);
  a.emit(0xA2, 0x00);
  a.label('oamClr');
  a.emit(0x9D, 0x00, 0x02); // STA $0200,X
  a.emit(0xE8);
  a.emit(0xD0); a.rel('oamClr');

  // --- フィールド 960 バイトクリア ---
  a.emit(0xA9, 0x00);
  a.emit(0xA8);             // TAY (=0)
  a.label('fldClr1');
  a.emit(0x99, 0x00, 0x03); // STA $0300,Y
  a.emit(0x99, 0x00, 0x04); // STA $0400,Y
  a.emit(0x99, 0x00, 0x05); // STA $0500,Y
  a.emit(0xC8);             // INY
  a.emit(0xD0); a.rel('fldClr1');
  a.label('fldClr2');
  a.emit(0x99, 0x00, 0x06); // STA $0600,Y
  a.emit(0xC8);
  a.emit(0xC0, 0xC0);       // CPY #$C0
  a.emit(0xD0); a.rel('fldClr2');

  // --- 外周リングを陣地(1)に ---
  // 行1 と 行28 を全て 1
  for (const row of [1, 28]) {
    a.emit(0xA2, row);      // LDX #row
    setPtrA();
    a.emit(0xA9, 0x01);
    a.emit(0xA0, 0x00);     // LDY #0
    a.label(`ring${row}`);
    a.emit(0x91, PTRA);     // STA (PTRA),Y
    a.emit(0xC8);
    a.emit(0xC0, 0x20);     // CPY #32
    a.emit(0xD0); a.rel(`ring${row}`);
  }
  // 行2..27 の列0/31
  a.emit(0xA2, 0x02);       // LDX #2
  a.label('ringCols');
  setPtrA();
  a.emit(0xA9, 0x01);
  a.emit(0xA0, 0x00);       // LDY #0
  a.emit(0x91, PTRA);
  a.emit(0xA0, 0x1F);       // LDY #31
  a.emit(0x91, PTRA);
  a.emit(0xE8);             // INX
  a.emit(0xE0, 0x1C);       // CPX #28
  a.emit(0xD0); a.rel('ringCols');

  // --- パレット書き込み ---
  a.emit(0xA9, 0x3F);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA2, 0x00);
  a.label('palLoop');
  a.emit(0xBD); a.abs('palette');
  a.emit(0x8D, 0x07, 0x20);
  a.emit(0xE8);
  a.emit(0xE0, 0x20);       // CPX #$20
  a.emit(0xD0); a.rel('palLoop');

  // --- ネームテーブル全描画 (フィールド配列から) ---
  a.emit(0xA9, 0x20);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA2, 0x00);       // LDX #0 (行)
  a.label('ntRow');
  setPtrA();
  a.emit(0xA0, 0x00);       // LDY #0
  a.label('ntCol');
  a.emit(0xB1, PTRA);       // LDA (PTRA),Y
  a.emit(0x8D, 0x07, 0x20); // STA $2007
  a.emit(0xC8);
  a.emit(0xC0, 0x20);       // CPY #32
  a.emit(0xD0); a.rel('ntCol');
  a.emit(0xE8);             // INX
  a.emit(0xE0, 0x1E);       // CPX #30
  a.emit(0xD0); a.rel('ntRow');
  // 勝利ライン目盛り (行0 列18 にマーカータイル)
  a.emit(0xA9, 0x20);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x12);       // 列18
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x05);       // タイル5
  a.emit(0x8D, 0x07, 0x20);

  // --- ゲーム変数初期化 ---
  a.emit(0xA9, START_PX); a.emit(0x85, PX);
  a.emit(0xA9, START_PY); a.emit(0x85, PY);
  a.emit(0xA9, 120); a.emit(0x85, QXP);   // Qix 中心座標
  a.emit(0xA9, 80);  a.emit(0x85, QYP);
  a.emit(0xA9, 0x01); a.emit(0x85, DQX);
  a.emit(0xA9, 0x01); a.emit(0x85, DQY);
  a.emit(0xA9, 0x03); a.emit(0x85, MOVEDLY);

  // スクロールリセット & 描画/NMI 有効化
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x05, 0x20);
  a.emit(0x8D, 0x05, 0x20);
  a.emit(0xA9, 0x80);       // NMI on, BG/SP パターン $0000
  a.emit(0x8D, 0x00, 0x20);
  a.emit(0xA9, 0x1E);       // BG+SP 表示
  a.emit(0x8D, 0x01, 0x20);

  // ================= メインループ =================
  // NMI がゲーム進行を担当。時間のかかる処理 (充填/ミス処理) だけここで実行
  a.label('forever');
  a.emit(0xA5, MODE);       // LDA MODE
  a.emit(0xC9, 0x01);       // CMP #1 (充填)
  a.emit(0xF0); a.rel('doFill');
  a.emit(0xC9, 0x03);       // CMP #3 (ミス)
  a.emit(0xF0); a.rel('doDeath');
  a.emit(0x4C); a.abs('forever');

  a.label('doFill');
  a.emit(0x20); a.abs('fill');       // JSR fill
  a.emit(0x4C); a.abs('startRedraw');
  a.label('doDeath');
  a.emit(0x20); a.abs('clearTrail'); // JSR clearTrail
  a.label('startRedraw');
  a.emit(0xA9, 0x01);
  a.emit(0x85, DRAWROW);    // 再描画は行1から
  a.emit(0xA9, 0x02);
  a.emit(0x85, MODE);       // MODE=2 (再描画)
  a.emit(0x4C); a.abs('forever');

  // ================= NMI =================
  a.label('nmi');
  a.emit(0x48);             // PHA
  a.emit(0x8A); a.emit(0x48); // TXA/PHA
  a.emit(0x98); a.emit(0x48); // TYA/PHA

  // --- VRAM フェーズ (vblank 冒頭に済ませる) ---
  a.emit(0xA5, MODE);
  a.emit(0xC9, 0x02);
  a.emit(0xD0); a.rel('notRedraw');
  a.emit(0x20); a.abs('redrawStep'); // JSR
  a.emit(0x4C); a.abs('vramDone');
  a.label('notRedraw');
  // 軌跡セルの差分書き込み
  a.emit(0xA5, DIRTY_F);
  a.emit(0xF0); a.rel('vramDone');
  a.emit(0xA6, DIRTY_R);    // LDX DIRTY_R
  a.emit(0xBD); a.abs('ntHi');
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xBD); a.abs('ntLo');
  a.emit(0x18);             // CLC
  a.emit(0x65, DIRTY_C);    // ADC DIRTY_C (行内なので桁上りなし)
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x02);       // 軌跡タイル
  a.emit(0x8D, 0x07, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x85, DIRTY_F);
  a.label('vramDone');

  // OAM DMA
  a.emit(0xA9, 0x02);
  a.emit(0x8D, 0x14, 0x40);

  // 勝利モード: 背景色を点滅
  a.emit(0xA5, MODE);
  a.emit(0xC9, 0x04);
  a.emit(0xD0); a.rel('noFlash');
  a.emit(0xE6, WINCNT);     // INC WINCNT
  a.emit(0xA9, 0x3F);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA5, WINCNT);
  a.emit(0x29, 0x10);       // AND #$10
  a.emit(0xF0); a.rel('flashDark');
  a.emit(0xA9, 0x2A);       // 緑
  a.emit(0x4C); a.abs('flashWrite');
  a.label('flashDark');
  a.emit(0xA9, 0x0F);       // 黒
  a.label('flashWrite');
  a.emit(0x8D, 0x07, 0x20);
  a.label('noFlash');

  // スクロールリセット
  a.emit(0xA9, 0x80);
  a.emit(0x8D, 0x00, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x05, 0x20);
  a.emit(0x8D, 0x05, 0x20);

  // --- ロジックフェーズ ---
  a.emit(0xA5, MODE);
  a.emit(0xF0); a.rel('logicPlay');   // MODE=0
  a.emit(0xC9, 0x04);
  a.emit(0xF0); a.rel('logicWin');    // MODE=4
  a.emit(0x4C); a.abs('nmiEnd');

  a.label('logicWin');
  a.emit(0x20); a.abs('readPad');
  a.emit(0xA5, PAD);
  a.emit(0x29, 0x10);       // START?
  a.emit(0xF0); a.rel('lwEnd');
  a.emit(0x4C); a.abs('reset');       // リスタート (SP は reset で再初期化)
  a.label('lwEnd');
  a.emit(0x4C); a.abs('nmiEnd');

  a.label('logicPlay');
  a.emit(0x20); a.abs('readPad');
  a.emit(0x20); a.abs('movePlayer');
  a.emit(0x20); a.abs('moveQix');
  a.emit(0x20); a.abs('buildOAM');

  a.label('nmiEnd');
  a.emit(0x68); a.emit(0xA8); // PLA/TAY
  a.emit(0x68); a.emit(0xAA); // PLA/TAX
  a.emit(0x68);             // PLA
  a.emit(0x40);             // RTI

  a.label('irq');
  a.emit(0x40);             // RTI

  // ================= サブルーチン =================

  // --- パッド読み取り → PAD (bit7=A,6=B,5=SEL,4=START,3=上,2=下,1=左,0=右) ---
  a.label('readPad');
  a.emit(0xA9, 0x01);
  a.emit(0x8D, 0x16, 0x40);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x16, 0x40);
  a.emit(0xA2, 0x08);
  a.label('rpLoop');
  a.emit(0xAD, 0x16, 0x40);
  a.emit(0x4A);             // LSR
  a.emit(0x26, PAD);        // ROL PAD
  a.emit(0xCA);
  a.emit(0xD0); a.rel('rpLoop');
  a.emit(0x60);             // RTS

  // --- 自機移動 (3フレームに1セル) ---
  a.label('movePlayer');
  a.emit(0xC6, MOVEDLY);    // DEC MOVEDLY
  a.emit(0xF0); a.rel('mpGo');
  a.emit(0x60);             // RTS
  a.label('mpGo');
  a.emit(0xA9, 0x03);
  a.emit(0x85, MOVEDLY);
  // 方向判定 (上>下>左>右)
  a.emit(0xA5, PAD); a.emit(0x29, 0x08);
  a.emit(0xD0); a.rel('dirUp');
  a.emit(0xA5, PAD); a.emit(0x29, 0x04);
  a.emit(0xD0); a.rel('dirDown');
  a.emit(0xA5, PAD); a.emit(0x29, 0x02);
  a.emit(0xD0); a.rel('dirLeft');
  a.emit(0xA5, PAD); a.emit(0x29, 0x01);
  a.emit(0xD0); a.rel('dirRight');
  a.emit(0x60);             // RTS (入力なし)

  a.label('dirUp');
  a.emit(0xA5, PY);
  a.emit(0xC9, 0x02);       // 行1 (リング) より上へは行けない
  a.emit(0xB0); a.rel('duOk');
  a.emit(0x60);
  a.label('duOk');
  a.emit(0x38); a.emit(0xE9, 0x01); // SEC/SBC #1
  a.emit(0x85, TTY);
  a.emit(0xA5, PX); a.emit(0x85, TTX);
  a.emit(0x4C); a.abs('tryStep');

  a.label('dirDown');
  a.emit(0xA5, PY);
  a.emit(0xC9, 0x1C);       // CMP #28
  a.emit(0x90); a.rel('ddOk');
  a.emit(0x60);
  a.label('ddOk');
  a.emit(0x18); a.emit(0x69, 0x01); // CLC/ADC #1
  a.emit(0x85, TTY);
  a.emit(0xA5, PX); a.emit(0x85, TTX);
  a.emit(0x4C); a.abs('tryStep');

  a.label('dirLeft');
  a.emit(0xA5, PX);
  a.emit(0xD0); a.rel('dlOk'); // PX==0 なら不可
  a.emit(0x60);
  a.label('dlOk');
  a.emit(0x38); a.emit(0xE9, 0x01);
  a.emit(0x85, TTX);
  a.emit(0xA5, PY); a.emit(0x85, TTY);
  a.emit(0x4C); a.abs('tryStep');

  a.label('dirRight');
  a.emit(0xA5, PX);
  a.emit(0xC9, 0x1F);       // CMP #31
  a.emit(0x90); a.rel('drOk');
  a.emit(0x60);
  a.label('drOk');
  a.emit(0x18); a.emit(0x69, 0x01);
  a.emit(0x85, TTX);
  a.emit(0xA5, PY); a.emit(0x85, TTY);
  // fallthrough → tryStep

  a.label('tryStep');
  a.emit(0xA6, TTY);        // LDX TTY (行)
  setPtrA();
  a.emit(0xA4, TTX);        // LDY TTX (列)
  a.emit(0xB1, PTRA);       // LDA (PTRA),Y
  a.emit(0xC9, 0x02);       // 軌跡は通れない
  a.emit(0xD0); a.rel('tsNotTrail');
  a.emit(0x60);
  a.label('tsNotTrail');
  a.emit(0xC9, 0x01);
  a.emit(0xF0); a.rel('tsClaimed');
  // 空き地 → 軌跡を引く
  a.emit(0xA9, 0x02);
  a.emit(0x91, PTRA);       // STA (PTRA),Y
  a.emit(0xA5, TTY); a.emit(0x85, DIRTY_R);
  a.emit(0xA5, TTX); a.emit(0x85, DIRTY_C);
  a.emit(0xA9, 0x01);
  a.emit(0x85, DIRTY_F);
  a.emit(0x85, TRAILF);
  a.emit(0x4C); a.abs('tsCommit');
  a.label('tsClaimed');
  // 陣地へ戻った: 軌跡があれば囲い完成 → 充填モード
  a.emit(0xA5, TRAILF);
  a.emit(0xF0); a.rel('tsCommit');
  a.emit(0xA9, 0x00); a.emit(0x85, TRAILF);
  a.emit(0xA9, 0x01); a.emit(0x85, MODE);   // MODE=1 (充填)
  a.label('tsCommit');
  a.emit(0xA5, TTX); a.emit(0x85, PX);
  a.emit(0xA5, TTY); a.emit(0x85, PY);
  a.emit(0x60);             // RTS

  // --- Qix 移動 (1px/フレーム、壁で反射、軌跡でミス) ---
  a.label('moveQix');
  // X 軸
  a.emit(0xA5, QXP);
  a.emit(0x18); a.emit(0x65, DQX); // CLC/ADC DQX
  a.emit(0x85, T0);
  a.emit(0x4A); a.emit(0x4A); a.emit(0x4A); // /8 → 列
  a.emit(0xA8);             // TAY
  a.emit(0xA5, QYP);
  a.emit(0x4A); a.emit(0x4A); a.emit(0x4A);
  a.emit(0xAA);             // TAX (行)
  setPtrA();
  a.emit(0xB1, PTRA);
  a.emit(0xC9, 0x01);
  a.emit(0xF0); a.rel('qBounceX');
  a.emit(0xC9, 0x02);
  a.emit(0xF0); a.rel('qDeath');
  a.emit(0xA5, T0);
  a.emit(0x85, QXP);
  a.emit(0x4C); a.abs('qMoveY');
  a.label('qBounceX');
  a.emit(0xA9, 0x00);
  a.emit(0x38); a.emit(0xE5, DQX); // SEC/SBC DQX (符号反転)
  a.emit(0x85, DQX);
  a.label('qMoveY');
  // Y 軸
  a.emit(0xA5, QYP);
  a.emit(0x18); a.emit(0x65, DQY);
  a.emit(0x85, T0);
  a.emit(0x4A); a.emit(0x4A); a.emit(0x4A);
  a.emit(0xAA);             // TAX (行)
  setPtrA();
  a.emit(0xA5, QXP);
  a.emit(0x4A); a.emit(0x4A); a.emit(0x4A);
  a.emit(0xA8);             // TAY (列)
  a.emit(0xB1, PTRA);
  a.emit(0xC9, 0x01);
  a.emit(0xF0); a.rel('qBounceY');
  a.emit(0xC9, 0x02);
  a.emit(0xF0); a.rel('qDeath');
  a.emit(0xA5, T0);
  a.emit(0x85, QYP);
  a.emit(0x60);             // RTS
  a.label('qBounceY');
  a.emit(0xA9, 0x00);
  a.emit(0x38); a.emit(0xE5, DQY);
  a.emit(0x85, DQY);
  a.emit(0x60);             // RTS
  a.label('qDeath');
  a.emit(0xA9, 0x03);
  a.emit(0x85, MODE);       // MODE=3 (ミス)
  a.emit(0x60);             // RTS

  // --- OAM バッファ構築 (スプライト0=自機, 1=Qix) ---
  a.label('buildOAM');
  a.emit(0xA5, PY);
  a.emit(0x0A); a.emit(0x0A); a.emit(0x0A); // ×8
  a.emit(0x38); a.emit(0xE9, 0x01);         // Y-1
  a.emit(0x8D, 0x00, 0x02);
  a.emit(0xA9, 0x04);       // 自機タイル
  a.emit(0x8D, 0x01, 0x02);
  a.emit(0xA9, 0x00);       // パレット0
  a.emit(0x8D, 0x02, 0x02);
  a.emit(0xA5, PX);
  a.emit(0x0A); a.emit(0x0A); a.emit(0x0A);
  a.emit(0x8D, 0x03, 0x02);
  a.emit(0xA5, QYP);
  a.emit(0x38); a.emit(0xE9, 0x05);         // 中心 → 左上 Y
  a.emit(0x8D, 0x04, 0x02);
  a.emit(0xA9, 0x03);       // Qix タイル (ボール)
  a.emit(0x8D, 0x05, 0x02);
  a.emit(0xA9, 0x01);       // パレット1
  a.emit(0x8D, 0x06, 0x02);
  a.emit(0xA5, QXP);
  a.emit(0x38); a.emit(0xE9, 0x04);         // 中心 → 左上 X
  a.emit(0x8D, 0x07, 0x02);
  a.emit(0x60);             // RTS

  // --- 再描画: 1 vblank に 1 行ずつ ---
  a.label('redrawStep');
  a.emit(0xA6, DRAWROW);    // LDX DRAWROW
  a.emit(0xE0, 0x1D);       // CPX #29 (行28まで描いたらバーへ)
  a.emit(0xB0); a.rel('drawBar');
  a.emit(0xBD); a.abs('ntHi');
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xBD); a.abs('ntLo');
  a.emit(0x8D, 0x06, 0x20);
  setPtrA();
  a.emit(0xA0, 0x00);
  a.label('rsCol');
  a.emit(0xB1, PTRA);       // セル値 = タイル番号
  a.emit(0x8D, 0x07, 0x20);
  a.emit(0xC8);
  a.emit(0xC0, 0x20);
  a.emit(0xD0); a.rel('rsCol');
  a.emit(0xE6, DRAWROW);
  a.emit(0x60);             // RTS

  a.label('drawBar');
  // バー長 = 陣地数 >> 5 (最大24)
  a.emit(0xA5, CLM_LO); a.emit(0x85, T0);
  a.emit(0xA5, CLM_HI); a.emit(0x85, T0 + 1);
  for (let i = 0; i < 5; i++) {
    a.emit(0x46, T0 + 1);   // LSR T0+1
    a.emit(0x66, T0);       // ROR T0
  }
  a.emit(0xA9, 0x20);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA9, 0x00);
  a.emit(0x8D, 0x06, 0x20);
  a.emit(0xA0, 0x00);       // LDY #0 (列)
  a.label('dbCol');
  a.emit(0xC4, T0);         // CPY T0
  a.emit(0xB0); a.rel('dbNotFill');
  a.emit(0xA9, 0x01);       // 塗りタイル
  a.emit(0x4C); a.abs('dbWrite');
  a.label('dbNotFill');
  a.emit(0xC0, 0x12);       // CPY #18 (勝利ライン)
  a.emit(0xD0); a.rel('dbEmpty');
  a.emit(0xA9, 0x05);       // マーカータイル
  a.emit(0x4C); a.abs('dbWrite');
  a.label('dbEmpty');
  a.emit(0xA9, 0x00);
  a.label('dbWrite');
  a.emit(0x8D, 0x07, 0x20);
  a.emit(0xC8);
  a.emit(0xC0, 0x20);
  a.emit(0xD0); a.rel('dbCol');
  // 再描画完了 → 勝利判定へ
  a.emit(0xA5, WINF);
  a.emit(0xF0); a.rel('dbToPlay');
  a.emit(0xA9, 0x04);
  a.emit(0x85, MODE);       // MODE=4 (勝利)
  a.emit(0x60);
  a.label('dbToPlay');
  a.emit(0xA9, 0x00);
  a.emit(0x85, MODE);       // MODE=0 (プレイ再開)
  a.emit(0x60);

  // --- 充填: Qix から到達できない空き地 + 軌跡を陣地化 ---
  a.label('fill');
  // シード: Qix のセルを 3 (到達可能マーク) に
  a.emit(0xA5, QYP);
  a.emit(0x4A); a.emit(0x4A); a.emit(0x4A);
  a.emit(0xAA);
  setPtrA();
  a.emit(0xA5, QXP);
  a.emit(0x4A); a.emit(0x4A); a.emit(0x4A);
  a.emit(0xA8);
  a.emit(0xB1, PTRA);
  a.emit(0xD0); a.rel('fillPasses'); // 空きでなければシードなし
  a.emit(0xA9, 0x03);
  a.emit(0x91, PTRA);

  // 拡散パス: 変化がなくなるまで走査
  a.label('fillPasses');
  a.emit(0xA9, 0x00);
  a.emit(0x85, CHANGED);
  a.emit(0xA2, 0x02);       // LDX #2 (行)
  a.label('fpRow');
  setPtrA();
  a.emit(0xCA);             // DEX (行-1)
  a.emit(0xBD); a.abs('fRowLo'); a.emit(0x85, PTRB);
  a.emit(0xBD); a.abs('fRowHi'); a.emit(0x85, PTRB + 1);
  a.emit(0xE8); a.emit(0xE8); // INX×2 (行+1)
  a.emit(0xBD); a.abs('fRowLo'); a.emit(0x85, PTRC);
  a.emit(0xBD); a.abs('fRowHi'); a.emit(0x85, PTRC + 1);
  a.emit(0xCA);             // DEX (元に戻す)
  a.emit(0xA0, 0x01);       // LDY #1 (列)
  a.label('fpCol');
  a.emit(0xB1, PTRA);
  a.emit(0xD0); a.rel('fpNext');   // 空き(0)のみ対象
  a.emit(0xB1, PTRB);       // 上
  a.emit(0xC9, 0x03);
  a.emit(0xF0); a.rel('fpMark');
  a.emit(0xB1, PTRC);       // 下
  a.emit(0xC9, 0x03);
  a.emit(0xF0); a.rel('fpMark');
  a.emit(0x88);             // DEY (左)
  a.emit(0xB1, PTRA);
  a.emit(0xC8);             // INY
  a.emit(0xC9, 0x03);
  a.emit(0xF0); a.rel('fpMark');
  a.emit(0xC8);             // INY (右)
  a.emit(0xB1, PTRA);
  a.emit(0x88);             // DEY
  a.emit(0xC9, 0x03);
  a.emit(0xF0); a.rel('fpMark');
  a.emit(0x4C); a.abs('fpNext');
  a.label('fpMark');
  a.emit(0xA9, 0x03);
  a.emit(0x91, PTRA);
  a.emit(0xA9, 0x01);
  a.emit(0x85, CHANGED);
  a.label('fpNext');
  a.emit(0xC8);             // INY
  a.emit(0xC0, 0x1F);       // CPY #31
  a.emit(0xD0); a.rel('fpCol');
  a.emit(0xE8);             // INX
  a.emit(0xE0, 0x1C);       // CPX #28
  a.emit(0xD0); a.rel('fpRowJmp');
  a.emit(0x4C); a.abs('fpDone');
  a.label('fpRowJmp');
  a.emit(0x4C); a.abs('fpRow');
  a.label('fpDone');
  a.emit(0xA5, CHANGED);
  a.emit(0xF0); a.rel('fpConvert');
  a.emit(0x4C); a.abs('fillPasses');

  // 変換 & 陣地カウント: 0/2→1(加算), 3→0, 1→加算
  a.label('fpConvert');
  a.emit(0xA9, 0x00);
  a.emit(0x85, CLM_LO);
  a.emit(0x85, CLM_HI);
  a.emit(0xA2, 0x02);
  a.label('cvRow');
  setPtrA();
  a.emit(0xA0, 0x01);
  a.label('cvCol');
  a.emit(0xB1, PTRA);
  a.emit(0xC9, 0x03);
  a.emit(0xF0); a.rel('cvBack');
  a.emit(0xC9, 0x01);
  a.emit(0xF0); a.rel('cvCount');
  // 0 または 2 → 陣地化
  a.emit(0xA9, 0x01);
  a.emit(0x91, PTRA);
  a.label('cvCount');
  a.emit(0xE6, CLM_LO);
  a.emit(0xD0); a.rel('cvNext');
  a.emit(0xE6, CLM_HI);
  a.emit(0x4C); a.abs('cvNext');
  a.label('cvBack');
  a.emit(0xA9, 0x00);
  a.emit(0x91, PTRA);
  a.label('cvNext');
  a.emit(0xC8);
  a.emit(0xC0, 0x1F);
  a.emit(0xD0); a.rel('cvCol');
  a.emit(0xE8);
  a.emit(0xE0, 0x1C);
  a.emit(0xD0); a.rel('cvRowJmp');
  a.emit(0x4C); a.abs('cvDone');
  a.label('cvRowJmp');
  a.emit(0x4C); a.abs('cvRow');
  a.label('cvDone');
  // 勝利判定: CLM >= 585
  a.emit(0xA5, CLM_HI);
  a.emit(0xC9, WIN_HI);
  a.emit(0x90); a.rel('noWin');
  a.emit(0xD0); a.rel('winYes');
  a.emit(0xA5, CLM_LO);
  a.emit(0xC9, WIN_LO);
  a.emit(0x90); a.rel('noWin');
  a.label('winYes');
  a.emit(0xA9, 0x01);
  a.emit(0x85, WINF);
  a.label('noWin');
  a.emit(0x60);             // RTS

  // --- ミス処理: 軌跡消去 & 自機リセット ---
  a.label('clearTrail');
  a.emit(0xA2, 0x02);
  a.label('ctRow');
  setPtrA();
  a.emit(0xA0, 0x01);
  a.label('ctCol');
  a.emit(0xB1, PTRA);
  a.emit(0xC9, 0x02);
  a.emit(0xD0); a.rel('ctNext');
  a.emit(0xA9, 0x00);
  a.emit(0x91, PTRA);
  a.label('ctNext');
  a.emit(0xC8);
  a.emit(0xC0, 0x1F);
  a.emit(0xD0); a.rel('ctCol');
  a.emit(0xE8);
  a.emit(0xE0, 0x1C);
  a.emit(0xD0); a.rel('ctRow');
  a.emit(0xA9, START_PX); a.emit(0x85, PX);
  a.emit(0xA9, START_PY); a.emit(0x85, PY);
  a.emit(0xA9, 0x00); a.emit(0x85, TRAILF);
  a.emit(0x60);             // RTS

  // ================= データ =================
  a.label('palette');
  // BG: 黒地 / 陣地=青 / 軌跡=黄 / ハイライト=白
  a.emit(0x0F, 0x11, 0x28, 0x30,  0x0F, 0x11, 0x28, 0x30,
         0x0F, 0x11, 0x28, 0x30,  0x0F, 0x11, 0x28, 0x30);
  // SP: 自機=白/橙, Qix=赤系
  a.emit(0x0F, 0x30, 0x27, 0x16,  0x0F, 0x16, 0x26, 0x30,
         0x0F, 0x2A, 0x3A, 0x30,  0x0F, 0x24, 0x34, 0x30);

  // 行アドレステーブル (フィールド RAM $0300+row*32 / ネームテーブル $2000+row*32)
  a.label('fRowLo');
  for (let r = 0; r < 30; r++) a.emit((0x0300 + r * 32) & 0xFF);
  a.label('fRowHi');
  for (let r = 0; r < 30; r++) a.emit((0x0300 + r * 32) >> 8);
  a.label('ntLo');
  for (let r = 0; r < 30; r++) a.emit((0x2000 + r * 32) & 0xFF);
  a.label('ntHi');
  for (let r = 0; r < 30; r++) a.emit((0x2000 + r * 32) >> 8);

  const code = a.assemble();
  const reset = a.labels['reset'], nmi = a.labels['nmi'], irq = a.labels['irq'];

  // ---- PRG 16KB ----
  const prg = new Uint8Array(0x4000);
  prg.set(code, 0);
  prg[0x3FFA] = nmi & 0xFF; prg[0x3FFB] = nmi >> 8;
  prg[0x3FFC] = reset & 0xFF; prg[0x3FFD] = reset >> 8;
  prg[0x3FFE] = irq & 0xFF; prg[0x3FFF] = irq >> 8;

  // ---- CHR 8KB ----
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
  setTile(0, () => 0);                                              // 空き地
  setTile(1, (x, y) => (x === 0 || y === 0) ? 3 : 1);               // 陣地 (青レンガ)
  setTile(2, (x, y) => (x >= 2 && x <= 5 && y >= 2 && y <= 5) ? 2 : 0); // 軌跡 (黄ドット)
  setTile(3, (x, y) => {                                            // Qix (ボール)
    const dx = x - 3.5, dy = y - 3.5;
    const d = dx * dx + dy * dy;
    return d < 6 ? 1 : (d < 12 ? 2 : 0);
  });
  setTile(4, (x, y) => {                                            // 自機 (ダイヤ)
    const d = Math.abs(x - 3.5) + Math.abs(y - 3.5);
    return d <= 2 ? 1 : (d <= 3.5 ? 2 : 0);
  });
  setTile(5, (x) => (x === 3 || x === 4) ? 2 : 0);                  // 勝利ライン目盛り

  // ---- iNES 組み立て ----
  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set([0x4E, 0x45, 0x53, 0x1A, 1, 1, 0x00, 0x00], 0);
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}
