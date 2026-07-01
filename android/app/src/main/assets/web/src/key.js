// key.js
// Krumhansl-Schmucklerのキー推定。
// 蓄積したクロマヒストグラム(各ピッチクラスの出現量)を、12回転させた
// メジャー/マイナーのプロファイルとピアソン相関で比較し、最も相関の高い
// キーを推定する。

import { PITCH_CLASS_NAMES } from './chroma.js';

// Krumhansl & Kessler (1982) のキープロファイル
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/** ピアソン相関係数。 */
function pearson(x, y) {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  if (den <= 1e-9) return 0;
  return num / den;
}

/** プロファイルを tonic 半音ぶん回転させる。 */
function rotate(profile, tonic) {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) {
    out[i] = profile[(i - tonic + 12) % 12];
  }
  return out;
}

/**
 * 蓄積クロマヒストグラムからキーを推定する。
 * @param {Float32Array|number[]} histogram 長さ12(正規化不要)
 * @returns {{name:string, tonic:number, mode:'major'|'minor', score:number,
 *           confidence:number}|null}
 */
export function estimateKey(histogram) {
  let total = 0;
  for (let i = 0; i < 12; i++) total += histogram[i];
  if (total < 1e-6) return null;

  const results = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    results.push({
      tonic,
      mode: 'major',
      score: pearson(histogram, rotate(MAJOR_PROFILE, tonic)),
    });
    results.push({
      tonic,
      mode: 'minor',
      score: pearson(histogram, rotate(MINOR_PROFILE, tonic)),
    });
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const second = results[1];

  // 1位と2位の差を 0..1 に潰した簡易な確信度。差が大きいほど確信が高い。
  const confidence = Math.max(0, Math.min(1, (best.score - second.score) * 4));

  return {
    name: PITCH_CLASS_NAMES[best.tonic] + (best.mode === 'major' ? ' Major' : ' Minor'),
    tonic: best.tonic,
    mode: best.mode,
    score: best.score,
    confidence,
  };
}

// ダイアトニック和音の度数と品質。
// メジャー: I ii iii IV V vi vii°
const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_QUALITIES = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
// (自然)マイナー: i ii° III iv v VI VII
// ただし v は実際の曲では属和音(メジャー/7th)になることが多いので 'maj' にしておく。
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10];
const MINOR_QUALITIES = ['min', 'dim', 'maj', 'min', 'maj', 'maj', 'maj'];

/**
 * キーのダイアトニック品質マップを作る。
 * @param {number} tonic 主音のピッチクラス(0..11)
 * @param {'major'|'minor'} mode
 * @returns {Array<'maj'|'min'|'dim'|null>} 長さ12。
 *   各ピッチクラスがそのキーのダイアトニック和音のルートなら期待品質、
 *   キー外なら null。
 */
export function diatonicQualityMap(tonic, mode) {
  const degrees = mode === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;
  const qualities = mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES;
  const map = new Array(12).fill(null);
  for (let i = 0; i < degrees.length; i++) {
    map[(tonic + degrees[i]) % 12] = qualities[i];
  }
  return map;
}
