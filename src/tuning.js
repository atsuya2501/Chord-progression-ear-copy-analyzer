// tuning.js
// グローバルなチューニングオフセット(基準ピッチのズレ)を推定する。
//
// 実演奏・実収録の曲は基準ピッチが標準(A=440Hz)から数十セント単位でズレて
// いることが珍しくない(アナログ時代のテープ速度のクセ、意図的な調律等)。
// 単純に「周波数→最寄りの半音に丸める」処理は、ズレが半音境界(50セント)に
// 近いほど、ちょっとしたエネルギー変動で隣のピッチクラスに化けやすくなる。
//
// 対策として、強いスペクトルピークの「最寄り半音からのズレ」を曲全体で
// 振幅重み付けして蓄積し、循環平均(±50セントで一周する量なので単純平均は
// 使えない)でグローバルなオフセットを1つ推定する。Essentia/HPCP等の
// MIR(音楽情報検索)ツールでも使われる標準的な手法。

const A4 = 440;
const LOG2 = Math.log(2);

export class TuningEstimator {
  /**
   * @param {number} minFreq 推定に使う周波数帯域の下限
   * @param {number} maxFreq 推定に使う周波数帯域の上限
   * @param {number} dbFloor これより小さいビンは無視
   */
  constructor(minFreq, maxFreq, dbFloor) {
    this.minFreq = minFreq;
    this.maxFreq = maxFreq;
    this.dbFloor = dbFloor;
    this.sumSin = 0;
    this.sumCos = 0;
    this.totalWeight = 0;
  }

  /**
   * 1フレーム分のスペクトルを蓄積する。
   * @param {Float32Array} freqData getFloatFrequencyData の結果(dB)
   * @param {number} sampleRate
   * @param {number} fftSize
   */
  process(freqData, sampleRate, fftSize) {
    const binWidth = sampleRate / fftSize;

    for (let i = 1; i < freqData.length; i++) {
      const freq = i * binWidth;
      if (freq < this.minFreq || freq > this.maxFreq) continue;

      const db = freqData[i];
      if (db < this.dbFloor || !isFinite(db)) continue;

      const amp = Math.pow(10, db / 20);

      // 最寄りの半音からのズレ(-0.5..0.5 半音)を、1半音=1周とみなして
      // 角度に変換し、振幅で重み付けしたsin/cosとして蓄積(循環統計)。
      const midi = 69 + 12 * (Math.log(freq / A4) / LOG2);
      const frac = midi - Math.round(midi);
      const theta = frac * 2 * Math.PI;

      this.sumSin += amp * Math.sin(theta);
      this.sumCos += amp * Math.cos(theta);
      this.totalWeight += amp;
    }
  }

  /**
   * 現在推定されているグローバルオフセットを返す(半音単位、-0.5..0.5)。
   * 蓄積が少なすぎる間は0(補正なし)を返す。
   */
  getOffsetSemitones() {
    if (this.totalWeight < 1e-6) return 0;
    return Math.atan2(this.sumSin, this.sumCos) / (2 * Math.PI);
  }

  /** 現在の推定オフセットをセント単位(¢, 1半音=100¢)で返す(表示用)。 */
  getOffsetCents() {
    return this.getOffsetSemitones() * 100;
  }

  reset() {
    this.sumSin = 0;
    this.sumCos = 0;
    this.totalWeight = 0;
  }
}
