// chords.js
// コードテンプレート定義と、クロマベクトルとのコサイン類似度による
// テンプレートマッチング。

import { PITCH_CLASS_NAMES, l2normalize } from './chroma.js';

// 各コードタイプの構成音を「ルートからの半音差」で定義する。
// suffix: 表示用の接尾辞 / intervals: 構成音(半音)
// tier:   'triad' = 基本の三和音(最優先で確定する)
//         'ext'   = 拡張コード(三和音を明確に上回ったときだけ採用)
//
// sus2/aug のように隣接音でたまたま当たりやすいコードは誤爆の原因になるため
// デフォルトからは外している(必要ならここに追記すれば復活できる)。
const CHORD_TYPES = [
  // --- 三和音(まずここでルート+メジャー/マイナーを確実に取る) ---
  { suffix: '',     tier: 'triad', intervals: [0, 4, 7] },          // major
  { suffix: 'm',    tier: 'triad', intervals: [0, 3, 7] },          // minor
  { suffix: 'dim',  tier: 'triad', intervals: [0, 3, 6] },          // diminished
  // --- 拡張(EXT_MARGIN以上、三和音を上回ったときだけ採用) ---
  { suffix: '7',    tier: 'ext',   intervals: [0, 4, 7, 10] },      // dominant 7th
  { suffix: 'm7',   tier: 'ext',   intervals: [0, 3, 7, 10] },      // minor 7th
  { suffix: 'maj7', tier: 'ext',   intervals: [0, 4, 7, 11] },      // major 7th
  { suffix: '6',    tier: 'ext',   intervals: [0, 4, 7, 9] },       // major 6th
  { suffix: 'm6',   tier: 'ext',   intervals: [0, 3, 7, 9] },       // minor 6th
  { suffix: 'add9', tier: 'ext',   intervals: [0, 4, 7, 14 % 12] }, // add9 (2 == 14%12)
  { suffix: 'sus4', tier: 'ext',   intervals: [0, 5, 7] },          // suspended 4th
];

// 拡張コードの採用しきい値まわり。
// 拡張を三和音より優先するには、生コサインで (EXT_MARGIN + EXT_NOTE_PENALTY) ぶん
// 三和音を上回る必要がある。合算 ≈ 0.09 を狙う。
//
// 根拠: クリーンな三和音では三和音テンプレが拡張を約0.13上回り、本物の拡張
// (add9等がしっかり鳴る)では拡張が三和音を約0.13上回る。一方、実音源のノイズで
// 余分な音が薄く漏れるだけの場合は数%(〜0.05)しか差がつかない。しきい値を両者の
// 中間 ≈0.09 に置くと「本物の拡張は通し、ノイズ由来の薄い漏れは三和音に留める」。
const EXT_MARGIN = 0.06;

// 拡張コード(4音テンプレ)への音数バイアス補正ペナルティ。
// 実音源ではクロマが12音に散るため、非ゼロ成分の多い4音テンプレは3音の三和音より
// 原理的にコサインが出やすい。この構造的な偏りを一律に差し引く。ルート間比較にも効く。
const EXT_NOTE_PENALTY = 0.03;

// ベース(低音)で強く鳴っているピッチクラスをルートに持つコードへの加点。
// Am7(A C E G)のように内部にCメジャー(C E G)を含むコードで、ルートのAが
// ベースに出ていれば A 系を優先でき、C との取り違えを減らせる。
// 0 にすると従来どおりベース無視。大きすぎるとベースのノイズに振り回される。
const ROOT_BONUS = 0.2;

// 推定キーのダイアトニック和音への加点。あくまで小さな後押しに留め、
// 裏コード/借用和音が来ても素のコサインが強ければ普通に採用されるようにする。
// DIATONIC_MATCH : ルートも品質もキーに合致(例: キーCでのDm)
// DIATONIC_ROOT  : ルートはキー内だが品質が違う(例: キーCでのD major)
const DIATONIC_MATCH_BONUS = 0.05;
const DIATONIC_ROOT_BONUS = 0.02;

/** コード接尾辞を三和音品質(maj/min/dim)に大まかに分類する。 */
function chordFamily(suffix) {
  if (suffix === 'dim') return 'dim';
  if (suffix === 'maj7') return 'maj';      // 'm'始まりだが長三和音系
  if (suffix.charAt(0) === 'm') return 'min'; // m, m7, m6
  return 'maj';                              // '', '7', '6', 'add9', 'sus4'
}

/**
 * テンプレートに対するキー(ダイアトニック)ボーナスを返す。
 * @param {{root:number, suffix:string}} t
 * @param {Array<'maj'|'min'|'dim'|null>|null} keyMap diatonicQualityMap の結果
 */
function diatonicBonus(t, keyMap) {
  if (!keyMap) return 0;
  const q = keyMap[t.root];
  if (q == null) return 0; // キー外のルートは加点なし(ペナルティも与えない)
  return chordFamily(t.suffix) === q ? DIATONIC_MATCH_BONUS : DIATONIC_ROOT_BONUS;
}

// 直前の確定コードからのルート移動に対する加点。
// カノン進行・王道進行・小室進行のような「よく使われる進行」は、特定の曲を
// 丸暗記するのではなく、それらに共通する「強い解決感を持つルート移動」を
// 汎用的に後押しすることで間接的にカバーする:
//   - 4度/5度移動(interval 5 or 7)  … V→I, ii→V, IV→I 等。最も強い進行感
//   - 3度移動(interval 3 or 4)      … I→vi, vi→IV 等。並行調/代理コードの関係
//   - 全音移動(interval 2)          … V→IV(バックドア)等。弱めに後押し
//   - 半音・トライトーン移動        … 稀な進行なので加点なし(ペナルティもなし)
// キー同様、曲がここから外れても素のコサインが強ければ普通に採用される。
const STAY_BONUS = 0.03;
const TRANSITION_CLASS_BONUS = { 0: STAY_BONUS, 1: 0, 2: 0.01, 3: 0.02, 4: 0.02, 5: 0.045, 6: 0 };

/**
 * テンプレートに対する遷移(ルート移動)ボーナスを返す。
 * @param {{root:number}} t
 * @param {number|null} prevRoot 直前に確定したコードのルート(0..11)。無ければ0。
 */
function transitionBonus(t, prevRoot) {
  if (prevRoot == null) return 0;
  const interval = (t.root - prevRoot + 12) % 12;
  const cls = Math.min(interval, 12 - interval); // 0..6、方向は区別しない
  return TRANSITION_CLASS_BONUS[cls] ?? 0;
}

/**
 * 全コード(12ルート × タイプ)のテンプレートを事前生成する。
 * 各テンプレートはL2正規化済みのクロマ(長さ12)。
 */
function buildTemplates() {
  const templates = [];
  for (let root = 0; root < 12; root++) {
    for (const type of CHORD_TYPES) {
      const vec = new Float32Array(12);
      for (const iv of type.intervals) {
        vec[(root + iv) % 12] = 1;
      }
      templates.push({
        name: PITCH_CLASS_NAMES[root] + type.suffix,
        root,
        suffix: type.suffix,
        tier: type.tier,
        numNotes: type.intervals.length,
        vector: l2normalize(vec),
      });
    }
  }
  return templates;
}

const TEMPLATES = buildTemplates();

/** コサイン類似度。両ベクトルともL2正規化済み前提なら内積と一致する。 */
function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += a[i] * b[i];
  return dot; // 正規化済み前提
}

/**
 * クロマベクトルに最も近いコードを推定する。
 *
 * 手順:
 *  1. 各テンプレートのコサイン類似度に、ベース(ルート)ボーナス・キー(ダイアト
 *     ニック)ボーナス・遷移(直前コードからのルート移動)ボーナスを加えた
 *     「調整スコア」を計算する。
 *  2. ルートごとに調整スコア最良の三和音/拡張を求め、拡張が三和音を EXT_MARGIN
 *     以上上回るときだけ拡張を採用(sus等の取り違え防止/確実に三和音まで)。
 *  3. ルート間は調整スコアで比較して最良を選ぶ。
 *     - ベースボーナス: 最低音で鳴るルートを優先(Am7↔C の取り違え補正)
 *     - キーボーナス  : 推定キーのダイアトニック和音を後押し(D↔Dm 等の品質補正)
 *     - 遷移ボーナス  : 直前コードからの「よくあるルート移動」を後押し
 * 表示用スコアはボーナスを含まない素のコサイン類似度を返す。
 *
 * @param {Float32Array} chroma L2正規化済みクロマ(長さ12)
 * @param {Float32Array|null} [bassChroma] L2正規化済みの低音域クロマ(ルートヒント)。
 * @param {Array<'maj'|'min'|'dim'|null>|null} [keyMap] diatonicQualityMap の結果。
 *        無ければキー補正なし。
 * @param {number|null} [prevRoot] 直前に確定したコードのルート(0..11)。
 *        無ければ遷移補正なし。
 * @returns {{name:string, score:number, root:number, suffix:string, tier:string}|null}
 */
export function matchChord(chroma, bassChroma = null, keyMap = null, prevRoot = null) {
  // 入力が実質無音なら判定不能
  let energy = 0;
  for (let i = 0; i < 12; i++) energy += chroma[i];
  if (energy < 1e-6) return null;

  // ルートごとに、調整スコア最良の三和音/拡張を集計する。
  // raw = 素のコサイン(表示用) / adj = ボーナス込み(選択用)
  const perRoot = Array.from({ length: 12 }, () => ({
    triad: null, triadRaw: -Infinity, triadAdj: -Infinity,
    ext: null, extRaw: -Infinity, extAdj: -Infinity,
  }));

  for (const t of TEMPLATES) {
    const raw = cosineSim(chroma, t.vector);
    const bassBonus = bassChroma ? ROOT_BONUS * bassChroma[t.root] : 0;
    // 拡張(4音)テンプレは音数バイアスを打ち消すため一律ペナルティ
    const notePenalty = t.tier === 'ext' ? EXT_NOTE_PENALTY : 0;
    const adj = raw + bassBonus + diatonicBonus(t, keyMap)
      + transitionBonus(t, prevRoot) - notePenalty;
    const slot = perRoot[t.root];
    if (t.tier === 'triad') {
      if (adj > slot.triadAdj) { slot.triadAdj = adj; slot.triadRaw = raw; slot.triad = t; }
    } else {
      if (adj > slot.extAdj) { slot.extAdj = adj; slot.extRaw = raw; slot.ext = t; }
    }
  }

  // 各ルートの代表コードを決め、調整スコアで最良ルートを選ぶ
  let best = null, bestAdjScore = -Infinity, bestRawScore = -Infinity;
  for (let root = 0; root < 12; root++) {
    const slot = perRoot[root];
    if (!slot.triad) continue;

    // ルート内で三和音優先、拡張はマージン超えのみ(調整スコアで比較)
    let chosen = slot.triad, chosenAdj = slot.triadAdj, chosenRaw = slot.triadRaw;
    if (slot.ext && slot.extAdj - slot.triadAdj >= EXT_MARGIN) {
      chosen = slot.ext;
      chosenAdj = slot.extAdj;
      chosenRaw = slot.extRaw;
    }

    if (chosenAdj > bestAdjScore) {
      bestAdjScore = chosenAdj;
      bestRawScore = chosenRaw;
      best = chosen;
    }
  }

  if (!best) return null;

  return {
    name: best.name,
    score: bestRawScore, // 表示用は素のコサイン類似度(ベース加点を含まない)
    root: best.root,
    suffix: best.suffix,
    tier: best.tier,
  };
}

export { TEMPLATES };
