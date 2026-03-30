# HDDSalvager2026

GoProで削除してしまったSD カード内の動画ファイルを効率的にサルベージし、ローカルフォルダに復元するWindowsデスクトップアプリケーション。

---

## 1. 要件定義

### 1.1 背景・目的

GoPro端末上で動画ファイルを削除した場合、ファイルシステム上のエントリは削除済みとなるが、物理的なデータセクタは即座には上書きされない。この特性を利用し、SDカードからrawレベルで動画データを復元する。

全ファイルの完全復元ではなく **直近1週間以内に撮影された動画** に絞ることで、スキャン時間とディスク使用量を最小化する。

### 1.2 機能要件

| ID | 機能 | 説明 |
|----|------|------|
| FR-01 | ドライブ選択 | 接続されたリムーバブルドライブ（SDカード）の一覧を表示し、対象ドライブを選択できる |
| FR-02 | スキャン実行 | 選択ドライブをrawレベルでスキャンし、削除済みの動画ファイルを検出する |
| FR-03 | ハイブリッド復旧 | **Phase 1:** FAT削除エントリからファイル名・日時・クラスタチェーンを復元。**Phase 2:** 見つからないファイルはMP4/MOVバイナリシグネチャによるファイルカービングでフォールバック |
| FR-04 | 日時フィルタ | MP4ヘッダ内の`creation_time`（moov > mvhd atom）を解析し、直近1週間以内のファイルのみを復元対象とする |
| FR-05 | 復元ファイル一覧 | 検出されたファイルをサムネイル・ファイル名・撮影日時・サイズと共にリスト表示する |
| FR-06 | 選択復元 | ユーザーが復元対象ファイルを個別選択 or 一括選択し、指定のローカルフォルダに保存できる |
| FR-07 | 進捗表示 | スキャン進捗・復元進捗をプログレスバーで表示する |
| FR-08 | 出力先指定 | 復元ファイルの保存先フォルダをユーザーが指定できる |

### 1.3 非機能要件

| ID | 項目 | 要件 |
|----|------|------|
| NFR-01 | 対応OS | Windows 10/11 (x64) |
| NFR-02 | 対応FS | FAT32 / exFAT（GoProのSDカード標準フォーマット） |
| NFR-03 | 対応コーデック | H.264 (AVC) / H.265 (HEVC) — GoPro HERO5〜13 |
| NFR-04 | 対応ファイル形式 | `.MP4` `.LRV`（低解像度プレビュー） `.THM`（サムネイル） |
| NFR-05 | 管理者権限 | rawディスクアクセスのため管理者権限で実行が必要 |
| NFR-06 | 読み取り専用 | SDカードへの書き込みは一切行わない（データ破壊防止） |
| NFR-07 | パフォーマンス | 64GB SDカードを5分以内にスキャン完了（USB 3.0接続時目標） |

---

## 2. システムアーキテクチャ

### 2.1 レイヤー構成

```
┌─────────────────────────────────────────┐
│            Renderer Process             │
│         (React + TypeScript)            │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ │
│  │ドライブ  │ │スキャン   │ │復元結果   │ │
│  │選択画面  │ │進捗画面   │ │一覧画面   │ │
│  └─────────┘ └──────────┘ └──────────┘ │
├─────────────────────────────────────────┤
│          IPC Bridge (contextBridge)     │
│          Electron preload.ts            │
├─────────────────────────────────────────┤
│            Main Process                 │
│         (Node.js + TypeScript)          │
│  ┌─────────────────────────────────┐    │
│  │        Recovery Engine          │    │
│  │  ┌───────────┐ ┌─────────────┐  │    │
│  │  │FAT Parser │ │File Carver  │  │    │
│  │  │(Phase 1)  │ │(Phase 2)    │  │    │
│  │  └───────────┘ └─────────────┘  │    │
│  │  ┌───────────┐ ┌─────────────┐  │    │
│  │  │MP4 Header │ │Raw Disk     │  │    │
│  │  │Parser     │ │Reader       │  │    │
│  │  └───────────┘ └─────────────┘  │    │
│  └─────────────────────────────────┘    │
├─────────────────────────────────────────┤
│     Native Module (N-API / Rust FFI)    │
│     Raw Disk I/O (CreateFile, DeviceIo) │
└─────────────────────────────────────────┘
```

### 2.2 復旧フロー

```
SDカード選択
    │
    ▼
rawディスクオープン (\\.\PhysicalDriveN)
    │
    ▼
ブートセクタ読み取り → FAT種別判定 (FAT32 / exFAT)
    │
    ├─── Phase 1: FAT削除エントリ復元 ───┐
    │    ディレクトリエントリをスキャン     │
    │    削除マーク (0xE5) のエントリ検出   │
    │    クラスタチェーン再構築             │
    │    MP4ヘッダからcreation_time取得     │
    │    → 1週間以内ならリストに追加        │
    │                                      │
    ├─── Phase 2: ファイルカービング ──────┐
    │    未割当クラスタをシーケンシャル走査  │
    │    MP4シグネチャ検出:                 │
    │      ftyp box (0x66747970)            │
    │    フッタ/サイズでファイル境界を特定   │
    │    MP4ヘッダからcreation_time取得     │
    │    → 1週間以内ならリストに追加        │
    │                                      │
    ▼                                      ▼
検出ファイル一覧を表示（サムネイル・日時・サイズ）
    │
    ▼
ユーザーが復元対象を選択
    │
    ▼
選択ファイルをローカルフォルダにコピー
    │
    ▼
完了レポート表示
```

### 2.3 MP4ヘッダ解析仕様

GoPro動画はISO Base Media File Format (ISO 14496-12) に準拠する。撮影日時の取得は以下のパスで行う:

```
ftyp box → moov box → mvhd box → creation_time (UTC epoch from 1904-01-01)
```

- `ftyp` boxのシグネチャ: `0x00000020 66747970` （GoPro典型値）
- GoPro固有の `ftyp` brand: `avc1`（H.264）, `mp41`（H.265）
- `creation_time` は1904年1月1日からの秒数（UTC）→ Unix epochに変換して使用

---

## 3. 技術スタック

| レイヤー | 技術 | 理由 |
|---------|------|------|
| UI フレームワーク | Electron 33+ | クロスプラットフォーム対応、豊富なエコシステム |
| フロントエンド | React 19 + TypeScript | コンポーネントベースUI、型安全性 |
| スタイリング | Tailwind CSS 4 | ユーティリティファースト、高速開発 |
| ビルドツール | Vite + electron-vite | 高速HMR、Electron最適化済みビルド |
| rawディスクI/O | Node.js N-API (C++) or node-ffi-napi | Windows API (`CreateFileW`, `DeviceIoControl`) 呼び出し |
| FAT解析 | 自前実装 (TypeScript) | FAT32/exFATの削除エントリ解析に特化した軽量実装 |
| MP4解析 | 自前実装 (TypeScript) | ftyp/moov/mvhd boxの最小限パース |
| パッケージング | electron-builder | Windows向け `.exe` インストーラ生成 |
| テスト | Vitest + Playwright | ユニットテスト + E2Eテスト |

---

## 4. ディレクトリ構成（予定）

```
APP_HDDSalvager2026/
├── README.md
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── src/
│   ├── main/                    # Electron Main Process
│   │   ├── index.ts             # エントリポイント
│   │   ├── ipc-handlers.ts      # IPC ハンドラ定義
│   │   ├── drive/
│   │   │   └── drive-detector.ts    # リムーバブルドライブ検出
│   │   ├── recovery/
│   │   │   ├── recovery-engine.ts   # 復旧エンジン（オーケストレーション）
│   │   │   ├── fat-parser.ts        # FAT32/exFAT 削除エントリ解析
│   │   │   ├── file-carver.ts       # バイナリシグネチャ ファイルカービング
│   │   │   ├── mp4-parser.ts        # MP4 ヘッダ解析 (creation_time取得)
│   │   │   └── raw-disk.ts          # rawディスク読み取り (Windows API)
│   │   └── utils/
│   │       └── date-filter.ts       # 日時フィルタリング
│   ├── preload/                 # Preload Script
│   │   └── index.ts             # contextBridge API定義
│   └── renderer/                # React Frontend
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── DriveSelector.tsx     # ドライブ選択
│       │   ├── ScanProgress.tsx      # スキャン進捗表示
│       │   ├── FileList.tsx          # 検出ファイル一覧
│       │   ├── FileCard.tsx          # ファイルカード（サムネイル付き）
│       │   └── RecoveryComplete.tsx  # 復元完了画面
│       ├── hooks/
│       │   └── useRecovery.ts       # 復元操作カスタムフック
│       └── styles/
│           └── globals.css
├── native/                      # C++ N-API ネイティブモジュール
│   ├── binding.gyp
│   ├── src/
│   │   └── raw_disk_win.cpp     # Windows raw disk access
│   └── index.d.ts              # TypeScript型定義
├── resources/                   # アプリアイコン等
└── tests/
    ├── unit/
    │   ├── fat-parser.test.ts
    │   ├── mp4-parser.test.ts
    │   └── file-carver.test.ts
    └── e2e/
        └── recovery-flow.test.ts
```

---

## 5. 使用方法

### 5.1 Docker で起動（推奨）

```bash
# イメージをビルド & 起動
docker compose up -d

# ブラウザでアクセス
# http://localhost:3000

# ログを確認
docker compose logs -f app

# 停止
docker compose down
```

**注意事項:**
- RAWディスクアクセスのため `privileged: true` で実行されます
- Linux環境で `/dev` をマウントしてデバイスにアクセスします
- 復元されたファイルは `./output` ディレクトリに保存されます

### 5.2 開発モード

```bash
# 依存関係をインストール
npm install

# 開発サーバーを起動（クライアント: Vite, サーバー: tsx watch）
npm run dev

# ブラウザでアクセス
# クライアント: http://localhost:5173
# サーバーAPI: http://localhost:3000
```

### 5.3 本番ビルド

```bash
# ビルド
npm run build

# 起動
npm start

# ブラウザでアクセス
# http://localhost:3000
```

---

## 6. 開発ロードマップ

### Phase 1: 基盤構築
- [ ] Electron + React + TypeScript プロジェクトセットアップ
- [ ] electron-vite ビルド環境構築
- [ ] 基本UI（ドライブ選択・進捗画面・結果画面）の骨組み

### Phase 2: コアエンジン
- [ ] Windows raw disk読み取りモジュール（N-API）
- [ ] FAT32/exFATブートセクタ・ディレクトリエントリパーサー
- [ ] FAT削除エントリ復元ロジック（Phase 1 復旧）
- [ ] MP4ヘッダパーサー（creation_time取得）

### Phase 3: ファイルカービング
- [ ] MP4/MOV バイナリシグネチャ検出
- [ ] ファイル境界特定（ftyp box size + moov/mdat解析）
- [ ] 未割当クラスタのシーケンシャルスキャン

### Phase 4: 統合・仕上げ
- [ ] Phase 1 → Phase 2 のフォールバック統合
- [ ] 日時フィルタ統合（1週間以内のみ表示）
- [ ] ファイル復元（選択 → ローカルフォルダへコピー）
- [ ] プログレスバー・エラーハンドリング

### Phase 5: パッケージング・テスト
- [ ] ユニットテスト（FATパーサー・MP4パーサー・カービング）
- [ ] 実機テスト（実際のGoPro SDカードで検証）
- [ ] electron-builder で `.exe` インストーラ生成
- [ ] UAC管理者権限昇格の設定

---

## 7. 注意事項

- **管理者権限**: rawディスクアクセス (`\\.\PhysicalDriveN`) にはWindows管理者権限が必須
- **読み取り専用**: アプリはSDカードに対して一切の書き込みを行わない設計とする
- **データ上書きリスク**: SDカードに新たなデータを書き込むと復元不可能になるため、復元前のSDカード使用を避けるようUIで警告を表示する
- **GoPro固有**: GoProはチャプター分割（GX010001.MP4, GX020001.MP4, ...）を行う。同一撮影セッションのチャプターを関連付けて表示することを将来的に検討
