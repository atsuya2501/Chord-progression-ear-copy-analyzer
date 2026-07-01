// onset.js
// スペクトルフラックスによるオンセット(音の立ち上がり/ビート)検出。
// フレーム間で「エネルギーが増えた分」の総和(正の変化のみ)を novelty とし、
// 直近の novelty 分布から作る適応しきい値を超えたらオンセットとみなす。
//
// ドラムがあればビート、無ければコード/ノートの変わり目を主に拾う。
// どちらでも「コードが切り替わる境目」を捉える用途に使える。

// フラックス計算の対象周波数帯域(Hz)。DC付近と超高域ノイズを除く。
const FLUX_MIN_FREQ = 40;
const FLUX_MAX_FREQ = 5000;
const DB_FLOOR = -100;

function dbToAmp(db) {
  if (!isFinite(db) || db < DB_FLOOR) return 0;
  return Math.pow(10, db / 20);
}

export class OnsetDetector {
  /**
   * @param {object} opts
   * @param {number} [opts.historySize=40] 適応しきい値に使う直近novelty数
   * @param {number} [opts.thresholdK=1.6]  平均+ K*標準偏差 をしきい値にする
   * @param {number} [opts.minGapMs=180]    オンセット間の最小間隔(連発防止)
   */
  constructor(opts = {}) {
    this.historySize = opts.historySize ?? 40;
    this.thresholdK = opts.thresholdK ?? 1.6;
    this.minGapMs = opts.minGapMs ?? 180;

    this.prevSpectrum = null;   // 直近の線形スペクトル
    this.noveltyHistory = [];   // 直近noveltyの履歴
    this.lastOnsetTime = -Infinity;
    this._minBin = null;
    this._maxBin = null;
  }

  _ensureBinRange(len, sampleRate, fftSize) {
    if (this._minBin !== null) return;
    const binWidth = sampleRate / fftSize;
    this._minBin = Math.max(1, Math.floor(FLUX_MIN_FREQ / binWidth));
    this._maxBin = Math.min(len - 1, Math.ceil(FLUX_MAX_FREQ / binWidth));
  }

  /**
   * 1フレーム処理。
   * @param {Float32Array} freqData getFloatFrequencyData の結果(dB)
   * @param {number} sampleRate
   * @param {number} fftSize
   * @param {number} nowMs performance.now() 等の現在時刻(ms)
   * @returns {{novelty:number, isOnset:boolean, threshold:number}}
   */
  process(freqData, sampleRate, fftSize, nowMs) {
    this._ensureBinRange(freqData.length, sampleRate, fftSize);

    // スペクトルフラックス(正の変化ぶんの総和)
    let flux = 0;
    if (this.prevSpectrum) {
      for (let i = this._minBin; i <= this._maxBin; i++) {
        const cur = dbToAmp(freqData[i]);
        const d = cur - this.prevSpectrum[i];
        if (d > 0) flux += d;
      }
    }

    // 現在の線形スペクトルを保存
    if (!this.prevSpectrum) this.prevSpectrum = new Float32Array(freqData.length);
    for (let i = 0; i < freqData.length; i++) {
      this.prevSpectrum[i] = dbToAmp(freqData[i]);
    }

    // 適応しきい値(直近noveltyの平均+K*標準偏差)
    let isOnset = false;
    let threshold = Infinity;
    const hist = this.noveltyHistory;
    if (hist.length >= 8) {
      let mean = 0;
      for (const v of hist) mean += v;
      mean /= hist.length;
      let variance = 0;
      for (const v of hist) variance += (v - mean) * (v - mean);
      variance /= hist.length;
      threshold = mean + this.thresholdK * Math.sqrt(variance);

      if (flux > threshold && (nowMs - this.lastOnsetTime) >= this.minGapMs) {
        isOnset = true;
        this.lastOnsetTime = nowMs;
      }
    }

    hist.push(flux);
    if (hist.length > this.historySize) hist.shift();

    return { novelty: flux, isOnset, threshold };
  }

  reset() {
    this.prevSpectrum = null;
    this.noveltyHistory = [];
    this.lastOnsetTime = -Infinity;
  }
}
