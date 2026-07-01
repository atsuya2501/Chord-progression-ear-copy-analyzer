// smoothing.js
// フレームごとの判定のガタつきを抑えるための2段スムージング。
//  (1) クロマベクトルの移動平均 … 入力レベルで平滑化
//  (2) コード名の多数決＋確定保持 … 出力レベルで安定化

import { l2normalize } from './chroma.js';

/** 直近Nフレームのクロマを平均する移動平均バッファ。 */
export class ChromaSmoother {
  /** @param {number} windowSize 平均するフレーム数 */
  constructor(windowSize = 8) {
    this.windowSize = windowSize;
    this.buffer = [];
  }

  /** 新しいクロマを追加し、平均(L2正規化済み)を返す。 */
  push(chroma) {
    this.buffer.push(chroma);
    if (this.buffer.length > this.windowSize) this.buffer.shift();

    const avg = new Float32Array(12);
    for (const c of this.buffer) {
      for (let i = 0; i < 12; i++) avg[i] += c[i];
    }
    for (let i = 0; i < 12; i++) avg[i] /= this.buffer.length;
    return l2normalize(avg);
  }

  reset() { this.buffer = []; }
}

/**
 * オンセット同期のクロマ平均器。
 * オンセット(ビート/コードの変わり目)でリセットし、区間内フレームの平均を返す。
 * サスティン部分を平均するのでパッシングトーンが薄まり、コード変化には
 * リセットで素早く追従できる。長い持続で固まらないよう最大フレームで減衰させる。
 */
export class SegmentChroma {
  /** @param {number} maxFrames この数を超えたら古い分を減衰(応答性を保つ) */
  constructor(maxFrames = 24) {
    this.maxFrames = maxFrames;
    this.sum = new Float32Array(12);
    this.count = 0;
  }

  /** フレームを追加し、区間平均(L2正規化済み)を返す。 */
  add(chroma) {
    // 上限に達したら古い蓄積を半減させ、直近を効かせつつ完全リセットは避ける
    if (this.count >= this.maxFrames) {
      for (let i = 0; i < 12; i++) this.sum[i] *= 0.5;
      this.count *= 0.5;
    }
    for (let i = 0; i < 12; i++) this.sum[i] += chroma[i];
    this.count += 1;
    return this.current();
  }

  /** オンセット時に区間を打ち切る。 */
  onOnset() {
    this.sum.fill(0);
    this.count = 0;
  }

  current() {
    const avg = new Float32Array(12);
    if (this.count > 0) {
      for (let i = 0; i < 12; i++) avg[i] = this.sum[i] / this.count;
    }
    return l2normalize(avg);
  }

  reset() {
    this.sum.fill(0);
    this.count = 0;
  }
}

/**
 * コード名の多数決＋ヒステリシスで「確定コード」を決める。
 * 直近のコード候補ウィンドウで最頻のものを採用し、一定回数連続して
 * 現在の確定値と異なる最頻値が出たときだけ切り替える。
 */
export class ChordStabilizer {
  /**
   * @param {object} opts
   * @param {number} [opts.windowSize=10]  多数決に使う直近フレーム数
   * @param {number} [opts.minConfidence=0.55] これ未満のスコアは候補から除外
   */
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? 10;
    this.minConfidence = opts.minConfidence ?? 0.55;
    this.window = [];          // 直近の候補({name,root}|null)
    this.confirmed = null;     // 現在の確定コード名
    this.confirmedRoot = null; // 現在の確定コードのルート(0..11)
  }

  /**
   * @param {{name:string, score:number, root:number}|null} match matchChord の結果
   * @returns {{confirmed:string|null, confirmedRoot:number|null, changed:boolean}}
   */
  update(match) {
    const candidate = match && match.score >= this.minConfidence ? match : null;
    this.window.push(candidate);
    if (this.window.length > this.windowSize) this.window.shift();

    // 多数決(nullも1票として数えるが、最頻がnullなら確定は据え置く)
    const counts = new Map(); // name -> {count, root}
    for (const c of this.window) {
      if (c == null) continue;
      const entry = counts.get(c.name) || { count: 0, root: c.root };
      entry.count += 1;
      counts.set(c.name, entry);
    }

    let topName = null;
    let topCount = 0;
    let topRoot = null;
    for (const [name, entry] of counts) {
      if (entry.count > topCount) { topCount = entry.count; topName = name; topRoot = entry.root; }
    }

    let changed = false;
    // 最頻コードがウィンドウの過半数を占めたときだけ確定を更新する
    if (topName && topCount >= Math.ceil(this.windowSize / 2) && topName !== this.confirmed) {
      this.confirmed = topName;
      this.confirmedRoot = topRoot;
      changed = true;
    }

    return { confirmed: this.confirmed, confirmedRoot: this.confirmedRoot, changed };
  }

  reset() {
    this.window = [];
    this.confirmed = null;
    this.confirmedRoot = null;
  }
}
