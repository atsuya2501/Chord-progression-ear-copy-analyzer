// audioEngine.js
// 音声入力とAnalyserNodeの管理。
// マイク入力をメインとしつつ、将来の音声ファイル入力にも対応しやすいよう
// 「ソースをAnalyserNodeに繋ぐ」部分を共通化している。

export class AudioEngine {
  /**
   * @param {object} opts
   * @param {number} [opts.fftSize=8192]   コード判定用FFTサイズ(2のべき乗)。
   * @param {number} [opts.bassFftSize=32768] ベース(ルート)用の高分解能FFTサイズ。
   *        低音域(65Hz付近)ではビン幅が半音間隔より粗くなるため、ベース専用に
   *        大きなFFTを別途持たせて分解能を確保する。時間窓は長くなる(約0.74秒)が
   *        ベースは変化が遅いので許容範囲。
   * @param {number} [opts.smoothingTimeConstant=0.6] AnalyserNode内部のスムージング。
   */
  constructor(opts = {}) {
    this.fftSize = opts.fftSize ?? 8192;
    this.bassFftSize = opts.bassFftSize ?? 32768;
    this.smoothingTimeConstant = opts.smoothingTimeConstant ?? 0.6;

    this.audioContext = null;
    this.analyser = null;
    this.bassAnalyser = null;   // ベース(ルート)推定用の高分解能アナライザ
    this.sourceNode = null;     // 現在繋がっている入力ソース(MediaStreamSource等)
    this.mediaStream = null;    // マイクのMediaStream(停止時のトラック解放用)
    this.freqData = null;       // getFloatFrequencyData用バッファ
    this.bassFreqData = null;   // ベース用バッファ
    this.running = false;
  }

  /** AudioContext / Analyser を遅延生成する。 */
  _ensureContext() {
    if (this.audioContext) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new Ctx();

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;
    this.freqData = new Float32Array(this.analyser.frequencyBinCount);

    this.bassAnalyser = this.audioContext.createAnalyser();
    this.bassAnalyser.fftSize = this.bassFftSize;
    this.bassAnalyser.smoothingTimeConstant = this.smoothingTimeConstant;
    this.bassFreqData = new Float32Array(this.bassAnalyser.frequencyBinCount);
  }

  /** マイク入力を開始する。 */
  async startMic() {
    this._ensureContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,   // 音楽解析では各種補正は切った方が素直
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    this._connectSource(this.audioContext.createMediaStreamSource(this.mediaStream));
    this.running = true;
  }

  /**
   * 音声ファイル(ArrayBuffer)を解析ソースとして繋ぐ。
   * 拡張用フック。返り値のAudioBufferSourceNodeを呼び出し側でstart()する想定。
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<AudioBufferSourceNode>}
   */
  async startFile(arrayBuffer) {
    this._ensureContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    const src = this.audioContext.createBufferSource();
    src.buffer = audioBuffer;
    // 解析しつつ実際に音も鳴らせるよう、Analyserを通した上でdestinationにも繋ぐ
    this._connectSource(src, /* alsoToDestination */ true);
    this.running = true;
    return src;
  }

  _connectSource(node, alsoToDestination = false) {
    this._disconnectSource();
    this.sourceNode = node;
    node.connect(this.analyser);
    node.connect(this.bassAnalyser);
    if (alsoToDestination) {
      node.connect(this.audioContext.destination);
    }
  }

  _disconnectSource() {
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (_) {}
      this.sourceNode = null;
    }
  }

  /** 最新の周波数スペクトル(dB)を取得する。 */
  getFrequencyData() {
    if (!this.analyser) return null;
    this.analyser.getFloatFrequencyData(this.freqData);
    return this.freqData;
  }

  /** ベース用の高分解能スペクトル(dB)を取得する。 */
  getBassFrequencyData() {
    if (!this.bassAnalyser) return null;
    this.bassAnalyser.getFloatFrequencyData(this.bassFreqData);
    return this.bassFreqData;
  }

  get sampleRate() {
    return this.audioContext ? this.audioContext.sampleRate : 44100;
  }

  /** 入力を停止し、マイクのトラックを解放する。 */
  stop() {
    this.running = false;
    this._disconnectSource();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }
}
