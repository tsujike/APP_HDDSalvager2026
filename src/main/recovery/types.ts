/** 復元候補のファイル情報 */
export interface RecoveredFile {
  /** 内部識別ID */
  id: string
  /** ファイル名（FAT復元時のみ利用可能、カービング時は生成名） */
  fileName: string
  /** 撮影日時 (Unix timestamp ms) — MP4 creation_time から取得 */
  creationTime: number
  /** ファイルサイズ (bytes) */
  fileSize: number
  /** コーデック種別 */
  codec: 'H.264' | 'H.265' | 'unknown'
  /** 復元方式 */
  recoveryMethod: 'fat-entry' | 'file-carving'
  /** ディスク上の開始オフセット (bytes) */
  diskOffset: number
  /** クラスタチェーン（FAT復元時）またはセクタ範囲 */
  clusters: number[]
  /** サムネイルデータ (base64 JPEG) — THMファイルから取得できた場合 */
  thumbnail?: string
  /** 復元の信頼度 (0.0〜1.0) */
  confidence: number
}

/** スキャン進捗イベント */
export interface ScanProgress {
  /** 現在のフェーズ */
  phase: 'fat-scan' | 'carving' | 'complete'
  /** 進捗率 (0〜100) */
  percent: number
  /** 現在処理中のセクタ */
  currentSector: number
  /** 総セクタ数 */
  totalSectors: number
  /** これまでに検出されたファイル数 */
  filesFound: number
}

/** ドライブ情報 */
export interface DriveInfo {
  /** ドライブレター (e.g., "E:") */
  letter: string
  /** ボリュームラベル */
  label: string
  /** 総容量 (bytes) */
  totalSize: number
  /** ファイルシステム種別 */
  fileSystem: 'FAT32' | 'exFAT' | 'unknown'
  /** 物理ドライブパス (e.g., "\\\\.\\PhysicalDrive2") */
  physicalDrive: string
  /** デバイス名 */
  deviceName: string
}

/** 復元設定 */
export interface RecoveryOptions {
  /** 対象ドライブ */
  drive: DriveInfo
  /** 日時フィルタ: この日時以降のファイルのみ復元 (Unix timestamp ms) */
  afterDate: number
  /** 出力先フォルダパス */
  outputDir: string
  /** ファイルカービングも実行するか */
  enableCarving: boolean
}

/** FAT ブートセクタ情報 */
export interface FATBootSector {
  /** セクタあたりのバイト数 */
  bytesPerSector: number
  /** クラスタあたりのセクタ数 */
  sectorsPerCluster: number
  /** 予約セクタ数 */
  reservedSectors: number
  /** FAT数 */
  numberOfFATs: number
  /** FATあたりのセクタ数 */
  sectorsPerFAT: number
  /** ルートディレクトリの開始クラスタ */
  rootCluster: number
  /** 総セクタ数 */
  totalSectors: number
  /** ファイルシステム種別 */
  type: 'FAT32' | 'exFAT'
  /** クラスタあたりのバイト数（算出値） */
  bytesPerCluster: number
  /** データ領域の開始セクタ */
  dataStartSector: number
}

/** FAT ディレクトリエントリ（削除済み含む） */
export interface FATDirectoryEntry {
  /** ファイル名 */
  fileName: string
  /** 拡張子 */
  extension: string
  /** 削除フラグ */
  isDeleted: boolean
  /** 開始クラスタ */
  startCluster: number
  /** ファイルサイズ */
  fileSize: number
  /** 作成日時 (Unix timestamp ms) */
  creationTime: number
  /** 更新日時 (Unix timestamp ms) */
  modifiedTime: number
  /** ロングファイルネーム */
  longFileName?: string
  /** 属性 */
  attributes: number
}
