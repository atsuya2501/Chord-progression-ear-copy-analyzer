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
 * 指定した周波数帯域のクロマベクトルを計算する内部関数。
 * @param {number} [tuningOffset=0] 半音単位のグローバルチューニング補正
 *        (tuning.js の TuningEstimator が推定)。実演奏の基準ピッチが
 *        標準(A=440Hz)からズレていると、半音境界付近の音が隣のピッチ
 *        クラスに化けやすいため、丸める前にこの分だけ差し引いて補正する。
 * @returns {Float32Array} 長さ12、L2正規化済み
 */
function chromaInBand(freqData, sampleRate, fftSize, minFreq, maxFreq, tuningOffset = 0) {
  const chroma = new Float32Array(12);
  const binWidth = sampleRate / fftSize;

  // i=0(DC成分)は飛ばす
  for (let i = 1; i < freqData.length; i++) {
    const freq = i * binWidth;
    if (freq < minFreq || freq > maxFreq) continue;

    const db = freqData[i];
    if (db < DB_FLOOR || !isFinite(db)) continue;

    // dB → 線形振幅
    const amp = Math.pow(10, db / 20);

    // 周波数 → MIDIノート番号(チューニング補正込み) → ピッチクラス(0..11)
    const midi = 69 + 12 * (Math.log(freq / A4) / LOG2) - tuningOffset;
    const pc = ((Math.round(midi) % 12) + 12) % 12;

    chroma[pc] += amp;
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
