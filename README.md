# コード進行解析アプリ（耳コピ支援）

マイクから流れている曲を解析し、リアルタイムでコード進行と推定キーを表示するWebアプリです。
「Shazamのコード版」的な、耳コピの当て勘補助ツール。フロントエンドのみで完結します。

## 仕組み（解析パイプライン）

```
マイク入力 → AnalyserNode(FFT) → クロマベクトル(12音) → スムージング
   → コード: テンプレートとのコサイン類似度マッチング
   → キー : Krumhansl-Schmucklerのプロファイル相関
```

| ファイル | 役割 |
| --- | --- |
| `src/audioEngine.js` | 音声入力とAnalyserNode管理（マイク／将来のファイル入力を抽象化） |
| `src/chroma.js` | FFTスペクトル → 12音クロマベクトル抽出 |
| `src/chords.js` | コードテンプレート定義＋コサイン類似度マッチング |
| `src/key.js` | Krumhansl-Schmucklerによるキー推定（24キー相関） |
| `src/smoothing.js` | クロマ移動平均＋コード多数決による安定化 |
| `src/app.js` | 全体制御・UI配線 |

## 起動方法

`getUserMedia`（マイク）は **https または localhost** でのみ動作します（`file://` で直接開くと使えません）。
ローカルサーバーを立ててください。

### 方法A: Python（インストール済みなら最も手軽）

```powershell
cd "chord-detector"
python -m http.server 8000
```

ブラウザで http://localhost:8000 を開く。

### 方法B: Node.js

```powershell
cd "chord-detector"
npx serve .
```

表示されたURL（http://localhost:3000 など）を開く。

起動したら「録音開始」を押し、マイク許可を与えてください。

## 使い方のコツ

- **PCのスピーカーから鳴っている曲をPCのマイクで拾う**形で十分動きます。音量は大きめが安定。
- 解析開始から **約10秒間はキー推定が「解析中...」** になります（サンプル蓄積中）。
- ドラム・ベースが混ざると誤判定は増えます。**ガタつかない安定表示**を優先する設計です。

## 表示の見方

- **中央の大きいコード** … 現在確定しているコード（多数決で安定化済み）
- **一致度** … テンプレートとのコサイン類似度。低いほど「あいまい」
- **クロマバー** … 12音それぞれのエネルギー。どの音が鳴っているかの生データ
- **コード進行** … 確定コードが切り替わるたびに右へ追記（現在のコードをハイライト）
- **Key** … 推定キー＋確信度（1位と2位の相関差ベース）

## チューニングどころ（`src/app.js` 上部の定数）

- `ANALYSIS_INTERVAL_MS` … 解析周期。短いほど反応が速いがガタつく
- `ChromaSmoother(8)` / `ChordStabilizer({windowSize:10})` … 大きいほど安定するが追従が遅い
- `ChordStabilizer.minConfidence` … 低一致度の候補を切り捨てる閾値
- `KEY_WARMUP_MS` … キー確定までのウォームアップ時間

## 今後の拡張ポイント

- 音声ファイル解析: `audioEngine.startFile(arrayBuffer)` を実装済み。UIにファイル入力を足すだけ。
- コードタイプ追加: `src/chords.js` の `CHORD_TYPES` に構成音を追記。
- PWA化: manifest + Service Worker を足せばオフライン/ホーム追加に対応可能。
