// app.js
// 全モジュールを配線するエントリポイント。
//  音声入力 → クロマ抽出 → スムージング → コード判定/キー推定 → UI更新

import { AudioEngine } from './audioEngine.js';
import {
  computeChroma, computeBassChroma, PITCH_CLASS_NAMES,
  TUNING_ANALYSIS_MIN_FREQ, TUNING_ANALYSIS_MAX_FREQ, TUNING_ANALYSIS_DB_FLOOR,
} from './chroma.js';
import { matchChord } from './chords.js';
import { estimateKey, diatonicQualityMap } from './key.js';
import { SegmentChroma, ChordStabilizer } from './smoothing.js';
import { OnsetDetector } from './onset.js';
import { TuningEstimator } from './tuning.js';

// ---- パラメータ ----
const ANALYSIS_INTERVAL_MS = 80;   // 解析周期(約12.5fps)
const KEY_WARMUP_MS = 10000;       // この時間が経つまでキーは「解析中...」
const KEY_UPDATE_MS = 1000;        // キー表示の更新間隔
const HISTORY_MAX = 32;            // コード履歴の保持数

// ---- 状態 ----
// オンセット検出のため、AnalyserNode側の時間平滑は弱めにして立ち上がりを残す。
const engine = new AudioEngine({ fftSize: 8192, smoothingTimeConstant: 0.15 });
const chromaSeg = new SegmentChroma(24);   // オンセット同期のコード用クロマ
const bassSeg = new SegmentChroma(24);     // オンセット同期のベースクロマ
const onsetDetector = new OnsetDetector({ thresholdK: 1.6, minGapMs: 180 });
const chordStabilizer = new ChordStabilizer({ windowSize: 10, minConfidence: 0.55 });
const tuningEstimator = new TuningEstimator(
  TUNING_ANALYSIS_MIN_FREQ, TUNING_ANALYSIS_MAX_FREQ, TUNING_ANALYSIS_DB_FLOOR,
);

let running = false;
let analysisTimer = null;
let startTime = 0;
let lastKeyUpdate = 0;
let keyMap = null;                          // 現在の推定キーのダイアトニック品質マップ
let prevChordRoot = null;                   // 直前に確定したコードのルート(遷移ボーナス用)
const keyHistogram = new Float32Array(12); // キー推定用の累積クロマ
const history = [];                         // 確定コードの時系列

// ---- DOM ----
const el = {
  toggleBtn: document.getElementById('toggleBtn'),
  status: document.getElementById('status'),
  currentChord: document.getElementById('currentChord'),
  chordConfidence: document.getElementById('chordConfidence'),
  keyName: document.getElementById('keyName'),
  keyConfidence: document.getElementById('keyConfidence'),
  history: document.getElementById('history'),
  chromaBars: document.getElementById('chromaBars'),
  tuningInfo: document.getElementById('tuningInfo'),
};

// クロマ可視化用のバーを12本生成
const chromaBarEls = [];
for (let i = 0; i < 12; i++) {
  const wrap = document.createElement('div');
  wrap.className = 'chroma-bar-wrap';
  const bar = document.createElement('div');
  bar.className = 'chroma-bar';
  const label = document.createElement('span');
  label.className = 'chroma-label';
  label.textContent = PITCH_CLASS_NAMES[i];
  wrap.appendChild(bar);
  wrap.appendChild(label);
  el.chromaBars.appendChild(wrap);
  chromaBarEls.push(bar);
}

// ---- 制御 ----
async function start() {
  try {
    el.status.textContent = 'マイク許可を待っています...';
    await engine.startMic();
  } catch (err) {
    el.status.textContent = 'マイクを開始できませんでした: ' + err.name + ': ' + err.message;
    // WebViewのlogcat(ChordDetectorWeb)にも詳細を残す
    console.error('startMic failed:', err && (err.name + ' / ' + err.message), err);
    return;
  }
  running = true;
  startTime = performance.now();
  lastKeyUpdate = 0;
  keyMap = null;
  prevChordRoot = null;
  keyHistogram.fill(0);
  history.length = 0;
  chromaSeg.reset();
  bassSeg.reset();
  onsetDetector.reset();
  chordStabilizer.reset();
  tuningEstimator.reset();
  el.tuningInfo.textContent = '';
  renderHistory();

  el.toggleBtn.textContent = '停止';
  el.toggleBtn.classList.add('active');
  el.status.textContent = '解析中';
  el.currentChord.textContent = '—';

  analysisTimer = setInterval(analyze, ANALYSIS_INTERVAL_MS);
}

function stop() {
  running = false;
  if (analysisTimer) { clearInterval(analysisTimer); analysisTimer = null; }
  engine.stop();
  el.toggleBtn.textContent = '録音開始';
  el.toggleBtn.classList.remove('active');
  el.status.textContent = '停止中';
}

// ---- 解析1ステップ ----
function analyze() {
  const freqData = engine.getFrequencyData();
  if (!freqData) return;

  const now = performance.now();

  // グローバルなチューニングのズレを継続推定し、周波数→ピッチクラス変換に反映
  tuningEstimator.process(freqData, engine.sampleRate, engine.fftSize);
  const tuningOffset = tuningEstimator.getOffsetSemitones();
  updateTuningUI();

  // オンセット(ビート/コードの変わり目)を検出し、区間クロマを打ち切る
  const { isOnset } = onsetDetector.process(
    freqData, engine.sampleRate, engine.fftSize, now,
  );
  if (isOnset) {
    chromaSeg.onOnset();
    bassSeg.onOnset();
    pulseBeat();
  }

  // クロマ/ベースを抽出し、オンセット同期で区間平均する(チューニング補正込み)
  const rawChroma = computeChroma(freqData, engine.sampleRate, engine.fftSize, tuningOffset);
  const smoothChroma = chromaSeg.add(rawChroma);

  // ベースは低音の分解能を稼ぐため専用の高分解能FFTから抽出する
  const bassFreqData = engine.getBassFrequencyData();
  const rawBass = computeBassChroma(
    bassFreqData, engine.sampleRate, engine.bassFftSize, tuningOffset,
  );
  const smoothBass = bassSeg.add(rawBass);

  // キー推定用ヒストグラムに加算
  for (let i = 0; i < 12; i++) keyHistogram[i] += smoothChroma[i];

  // コード判定(ベース=ルートヒント、キー=ダイアトニック重み、
  // 直前コード=遷移(ルート移動)の重みに使う) → 安定化
  const match = matchChord(smoothChroma, smoothBass, keyMap, prevChordRoot);
  const { confirmed, confirmedRoot, changed } = chordStabilizer.update(match);
  prevChordRoot = confirmedRoot; // 次フレームの遷移ボーナスに使う

  updateChordUI(confirmed, match);
  updateChromaBars(smoothChroma);
  if (changed && confirmed) pushHistory(confirmed);

  // キー推定(ウォームアップ後、一定間隔で)
  const elapsed = now - startTime;
  updateKeyUI(elapsed);
}

// ---- UI更新 ----
function updateTuningUI() {
  const cents = tuningEstimator.getOffsetCents();
  // ±3¢程度は誤差扱いにして「補正なし」と表示し、チラつきを抑える
  if (Math.abs(cents) < 3) {
    el.tuningInfo.textContent = 'チューニング: 標準';
  } else {
    const sign = cents > 0 ? '+' : '';
    el.tuningInfo.textContent = `チューニング: ${sign}${cents.toFixed(0)}¢`;
  }
}

// オンセット検出時に現在コードのカードを一瞬光らせる(ビート同期の視覚フィードバック)
let beatPulseTimer = null;
function pulseBeat() {
  el.currentChord.classList.add('beat');
  if (beatPulseTimer) clearTimeout(beatPulseTimer);
  beatPulseTimer = setTimeout(() => el.currentChord.classList.remove('beat'), 90);
}

function updateChordUI(confirmed, match) {
  el.currentChord.textContent = confirmed || '—';
  if (match) {
    el.chordConfidence.textContent = '一致度 ' + Math.round(match.score * 100) + '%';
  } else {
    el.chordConfidence.textContent = '';
  }
}

function updateChromaBars(chroma) {
  let max = 0;
  for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);
  for (let i = 0; i < 12; i++) {
    const h = max > 0 ? (chroma[i] / max) * 100 : 0;
    chromaBarEls[i].style.height = h.toFixed(1) + '%';
  }
}

function updateKeyUI(elapsed) {
  if (elapsed < KEY_WARMUP_MS) {
    const remain = Math.ceil((KEY_WARMUP_MS - elapsed) / 1000);
    el.keyName.textContent = '解析中...';
    el.keyConfidence.textContent = `(あと約${remain}秒)`;
    return;
  }
  if (elapsed - lastKeyUpdate < KEY_UPDATE_MS) return;
  lastKeyUpdate = elapsed;

  const key = estimateKey(keyHistogram);
  if (!key) return;
  // 推定キーからダイアトニック品質マップを更新(コード判定の重み付けに使う)
  keyMap = diatonicQualityMap(key.tonic, key.mode);
  el.keyName.textContent = 'Key: ' + key.name;
  const pct = Math.round(key.confidence * 100);
  el.keyConfidence.textContent = pct >= 50 ? `確信度 ${pct}%` : `確信度 ${pct}%(揺れ中)`;
}

function pushHistory(name) {
  history.push(name);
  if (history.length > HISTORY_MAX) history.shift();
  renderHistory();
}

function renderHistory() {
  el.history.innerHTML = '';
  history.forEach((name, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chord-chip';
    if (idx === history.length - 1) chip.classList.add('current');
    chip.textContent = name;
    el.history.appendChild(chip);
    if (idx < history.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      el.history.appendChild(arrow);
    }
  });
  // 最新を見せるため右端へスクロール
  el.history.scrollLeft = el.history.scrollWidth;
}

// ---- イベント ----
el.toggleBtn.addEventListener('click', () => {
  if (running) stop(); else start();
});

// secure context(https/localhost)でないとgetUserMediaは使えない
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  el.status.textContent =
    'この環境ではマイクが使えません(httpsまたはlocalhostで開いてください)';
  el.toggleBtn.disabled = true;
  console.error(
    'mediaDevices unavailable:',
    'isSecureContext=', window.isSecureContext,
    'origin=', location.origin,
    'hasMediaDevices=', !!navigator.mediaDevices,
  );
}
