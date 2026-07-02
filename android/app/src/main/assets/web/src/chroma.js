// chroma.js
// AnalyserNodeの周波数スペクトル(dB)から、12音のクロマベクトル
// (ピッチクラスプロファイル: C, C#, D, ... B のエネルギー分布)を作る。

// 解析対象の周波数帯域。低すぎ(ベース/かぶり)・高すぎ(倍音/ノイズ)を除外して
// コードの構成音が出やすい帯域に絞る。C2(約65Hz)〜C7(約2093Hz)。
const MIN_FREQ = 65;
const MAX_FREQ = 2093;
const DB_FLOOR = -80; // これより小さいビンは無視(無音/ノイズ扱い)

// ベース(ルート音)推定用の低音域。コードの最低音はこの辺りに出やすい。
// 下限はキックドラムの超低域をある程度避けるため65Hz、上限はベース〜低中域。
const BASS_MIN_FREQ = 65;
const BASS_MAX_FREQ = 300;

const A4 = 440;
const LOG2 = Math.log(2);

/**
 * スペクトルから局所ピーク(山の頂点)だけを抽出する。
 *
 * 帯域内の全ビンを合算すると、ドラムの広帯域エネルギーや床ノイズが
 * 常にクロマへ漏れ込む。楽音は狭いピークとして現れるので、局所最大の
 * ビンだけを採用することでノイズの寄与を大きく減らせる。
 * さらに放物線補間(頂点とその両隣のdB値から真の頂点位置を推定)で、
 * FFTのビン幅より細かい周波数精度を得る。ビン幅は約5.9Hz(fft8192/48kHz)
 * あり、低音域では半音間隔より粗いので、この補間が音程の取り違え防止に効く。
 *
 * @param {Float32Array} freqData getFloatFrequencyData の結果(dB)
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {number} minFreq 対象帯域の下限(Hz)
 * @param {number} maxFreq 対象帯域の上限(Hz)
 * @param {number} [dbFloor=DB_FLOOR] これより弱いピークは無視
 * @returns {Array<{freq:number, amp:number}>} 補間済み周波数と線形振幅
 */
export function extractPeaks(freqData, sampleRate, fftSize, minFreq, maxFreq, dbFloor = DB_FLOOR) {
  const binWidth = sampleRate / fftSize;
  const peaks = [];
  const iMin = Math.max(2, Math.floor(minFreq / binWidth));
  const iMax = Math.min(freqData.length - 2, Math.ceil(maxFreq / binWidth));

  for (let i = iMin; i <= iMax; i++) {
    const b = freqData[i];
    if (b < dbFloor || !isFinite(b)) continue;
    const a = freqData[i - 1];
    const c = freqData[i + 1];
    // 局所最大のみ(平坦な連続は左端を採用)
    if (!(b > a && b >= c)) continue;

    // 放物線補間: 頂点のずれ delta ∈ (-0.5, 0.5) と真の頂点dBを推定
    let delta = 0;
    let peakDb = b;
    if (isFinite(a) && isFinite(c)) {
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-12) {
        delta = 0.5 * (a - c) / denom;
        if (delta > -1 && delta < 1) {
          peakDb = b - 0.25 * (a - c) * delta;
        } else {
          delta = 0;
        }
      }
    }

    peaks.push({
      freq: (i + delta) * binWidth,
      amp: Math.pow(10, peakDb / 20),
    });
  }
  return peaks;
}

/**
 * 指定した周波数帯域のクロマベクトルを計算する内部関数。
 * ピーク抽出方式: 局所ピークのみをピッチクラスへ集計する。
 * @param {number} [tuningOffset=0] 半音単位のグローバルチューニング補正
 *        (tuning.js の TuningEstimator が推定)。実演奏の基準ピッチが
 *        標準(A=440Hz)からズレていると、半音境界付近の音が隣のピッチ
 *        クラスに化けやすいため、丸める前にこの分だけ差し引いて補正する。
 * @returns {Float32Array} 長さ12、L2正規化済み
 */
function chromaInBand(freqData, sampleRate, fftSize, minFreq, maxFreq, tuningOffset = 0) {
  const chroma = new Float32Array(12);
  const peaks = extractPeaks(freqData, sampleRate, fftSize, minFreq, maxFreq);

  for (const p of peaks) {
    // 周波数 → MIDIノート番号(チューニング補正込み) → ピッチクラス(0..11)
    const midi = 69 + 12 * (Math.log(p.freq / A4) / LOG2) - tuningOffset;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pc] += p.amp;
  }

  return l2normalize(chroma);
}

/**
 * 周波数スペクトルからクロマベクトル(コード判定用・中広域)を計算する。
 * @param {Float32Array} freqData getFloatFrequencyData の結果(dB)
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {number} [tuningOffset=0] 半音単位のグローバルチューニング補正
 * @returns {Float32Array} 長さ12、L2正規化済み(全ゼロのときは全ゼロ)
 */
export function computeChroma(freqData, sampleRate, fftSize, tuningOffset = 0) {
  return chromaInBand(freqData, sampleRate, fftSize, MIN_FREQ, MAX_FREQ, tuningOffset);
}

/**
 * 低音域だけからクロマを計算する(ルート音ヒント用)。
 * 最低音=コードのルートになりやすいという前提で、コード判定の補助に使う。
 * @param {number} [tuningOffset=0] 半音単位のグローバルチューニング補正
 * @returns {Float32Array} 長さ12、L2正規化済み
 */
export function computeBassChroma(freqData, sampleRate, fftSize, tuningOffset = 0) {
  return chromaInBand(freqData, sampleRate, fftSize, BASS_MIN_FREQ, BASS_MAX_FREQ, tuningOffset);
}

// チューニング推定(tuning.js)で使う周波数帯域とdBフロアを共有する。
export const TUNING_ANALYSIS_MIN_FREQ = MIN_FREQ;
export const TUNING_ANALYSIS_MAX_FREQ = MAX_FREQ;
export const TUNING_ANALYSIS_DB_FLOOR = DB_FLOOR;

/** L2正規化(ベクトルの長さを1にする)。全ゼロならそのまま返す。 */
export function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm <= 1e-9) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

export const PITCH_CLASS_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];
