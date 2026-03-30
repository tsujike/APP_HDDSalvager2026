import type { FATBootSector, FATDirectoryEntry } from './types.js'
import { readSectors, readSectorRange } from './raw-disk.js'

/**
 * FAT32/exFAT パーサー
 *
 * SDカードのブートセクタを解析し、削除済みディレクトリエントリを検出する。
 */

/** 削除済みエントリのマーカー (0xE5) — FAT32用 */
const DELETED_MARKER = 0xe5

/** ディレクトリエントリのサイズ (32 bytes) */
const DIR_ENTRY_SIZE = 32

/** LFNエントリの属性値 */
const ATTR_LONG_NAME = 0x0f

/** 属性: ディレクトリ */
const ATTR_DIRECTORY = 0x10

/** 属性: ボリュームラベル */
const ATTR_VOLUME_ID = 0x08

// ──── exFAT エントリタイプ ────
const EXFAT_FILE_ENTRY = 0x85
const EXFAT_FILE_ENTRY_DELETED = 0x05
const EXFAT_STREAM_EXT = 0xc0
const EXFAT_STREAM_EXT_DELETED = 0x40
const EXFAT_FILENAME_EXT = 0xc1
const EXFAT_FILENAME_EXT_DELETED = 0x41

// ──── FATテーブルキャッシュ ────
let fatTableCache: Buffer | null = null
let fatCacheBoot: FATBootSector | null = null

/**
 * FATテーブルを一括でメモリに読み込む。
 * 128GB exFATカード(128KBクラスタ)で約4MB、FAT32(32KBクラスタ)で約16MB。
 * これにより getNextCluster が毎回ディスク読み取りせずメモリ参照になる。
 */
export function loadFATCache(fd: number, boot: FATBootSector): void {
  const fatSizeBytes = boot.sectorsPerFAT * boot.bytesPerSector
  const maxCacheSize = 128 * 1024 * 1024 // 128MB上限
  if (fatSizeBytes > maxCacheSize) {
    // 巨大FATは部分キャッシュ（先頭128MBのみ）
    fatTableCache = readSectors(fd, boot.reservedSectors * boot.bytesPerSector, maxCacheSize)
  } else {
    fatTableCache = readSectors(fd, boot.reservedSectors * boot.bytesPerSector, fatSizeBytes)
  }
  fatCacheBoot = boot
}

/**
 * FATキャッシュを解放する。
 */
export function releaseFATCache(): void {
  fatTableCache = null
  fatCacheBoot = null
}

/**
 * ブートセクタを解析してFAT情報を返す。
 */
export function parseBootSector(fd: number): FATBootSector {
  const buf = readSectors(fd, 0, 512)

  // exFATの判定: オフセット3に "EXFAT   " がある
  const oem = buf.toString('ascii', 3, 11).trim()
  if (oem === 'EXFAT') {
    return parseExFATBootSector(buf)
  }

  // FAT32
  return parseFAT32BootSector(buf)
}

function parseFAT32BootSector(buf: Buffer): FATBootSector {
  const bytesPerSector = buf.readUInt16LE(11)
  const sectorsPerCluster = buf.readUInt8(13)
  const reservedSectors = buf.readUInt16LE(14)
  const numberOfFATs = buf.readUInt8(16)
  const sectorsPerFAT = buf.readUInt32LE(36)
  const rootCluster = buf.readUInt32LE(44)

  // 総セクタ数: 16bitが0なら32bitを使用
  let totalSectors = buf.readUInt16LE(19)
  if (totalSectors === 0) {
    totalSectors = buf.readUInt32LE(32)
  }

  const bytesPerCluster = bytesPerSector * sectorsPerCluster
  const dataStartSector = reservedSectors + numberOfFATs * sectorsPerFAT

  return {
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numberOfFATs,
    sectorsPerFAT,
    rootCluster,
    totalSectors,
    type: 'FAT32',
    bytesPerCluster,
    dataStartSector
  }
}

function parseExFATBootSector(buf: Buffer): FATBootSector {
  const sectorSizeShift = buf.readUInt8(108)
  const clusterSizeShift = buf.readUInt8(109)
  const bytesPerSector = 1 << sectorSizeShift
  const sectorsPerCluster = 1 << clusterSizeShift
  const reservedSectors = buf.readUInt32LE(80) // FatOffset（セクタ単位）
  const numberOfFATs = buf.readUInt8(110)
  const sectorsPerFAT = buf.readUInt32LE(84) // FatLength（セクタ単位）
  const rootCluster = buf.readUInt32LE(96) // FirstClusterOfRootDirectory
  const totalSectors = Number(buf.readBigUInt64LE(72)) // VolumeLength
  const dataStartSector = buf.readUInt32LE(88) // ClusterHeapOffset

  return {
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numberOfFATs,
    sectorsPerFAT,
    rootCluster,
    totalSectors,
    type: 'exFAT',
    bytesPerCluster: bytesPerSector * sectorsPerCluster,
    dataStartSector
  }
}

/**
 * クラスタ番号をセクタ番号に変換する。
 */
export function clusterToSector(
  cluster: number,
  boot: FATBootSector
): number {
  return boot.dataStartSector + (cluster - 2) * boot.sectorsPerCluster
}

/**
 * クラスタ番号をバイトオフセットに変換する。
 */
export function clusterToOffset(
  cluster: number,
  boot: FATBootSector
): number {
  return clusterToSector(cluster, boot) * boot.bytesPerSector
}

/**
 * FATテーブルから次のクラスタを読み取る。
 * キャッシュ済みの場合はメモリから直接読み取り（プロセス起動なし）。
 */
export function getNextCluster(
  fd: number,
  cluster: number,
  boot: FATBootSector
): number {
  const fatOffset = cluster * 4

  // キャッシュ利用
  if (fatTableCache && fatOffset + 4 <= fatTableCache.length) {
    const raw = fatTableCache.readUInt32LE(fatOffset)
    return boot.type === 'FAT32' ? raw & 0x0fffffff : raw
  }

  // フォールバック: ディスクから直接読み取り
  if (boot.type === 'FAT32') {
    const fatSector = boot.reservedSectors + Math.floor(fatOffset / boot.bytesPerSector)
    const entryOffset = fatOffset % boot.bytesPerSector
    const buf = readSectors(fd, fatSector * boot.bytesPerSector, boot.bytesPerSector)
    return buf.readUInt32LE(entryOffset) & 0x0fffffff
  }
  // exFAT
  const fatByteOffset = boot.reservedSectors * boot.bytesPerSector + fatOffset
  const buf = readSectors(fd, fatByteOffset, 4)
  return buf.readUInt32LE(0)
}

/**
 * クラスタチェーンが終端かどうかを判定する。
 */
export function isEndOfChain(cluster: number, type: 'FAT32' | 'exFAT'): boolean {
  if (type === 'FAT32') {
    return cluster >= 0x0ffffff8
  }
  // exFAT
  return cluster >= 0xfffffff8
}

/**
 * 削除済みクラスタかどうか（空きクラスタ）。
 */
export function isFreeCluster(cluster: number): boolean {
  return cluster === 0
}

/**
 * ディレクトリエントリをスキャンし、削除済みファイルを検出する。
 * FAT32とexFATで異なるエントリ形式を処理する。
 * 対象拡張子: MP4, LRV, THM
 */
export function scanDeletedEntries(
  fd: number,
  boot: FATBootSector,
  onProgress?: (scannedClusters: number) => void
): FATDirectoryEntry[] {
  if (boot.type === 'exFAT') {
    return scanDeletedEntriesExFAT(fd, boot, onProgress)
  }
  return scanDeletedEntriesFAT32(fd, boot, onProgress)
}

/** FAT32用の削除エントリスキャン */
function scanDeletedEntriesFAT32(
  fd: number,
  boot: FATBootSector,
  onProgress?: (scannedClusters: number) => void
): FATDirectoryEntry[] {
  const entries: FATDirectoryEntry[] = []
  const targetExtensions = new Set(['MP4', 'LRV', 'THM'])
  const visitedClusters = new Set<number>()
  let scannedCount = 0

  function scanDirectory(startCluster: number): void {
    let cluster = startCluster

    while (!isEndOfChain(cluster, boot.type) && !isFreeCluster(cluster)) {
      if (visitedClusters.has(cluster)) break
      visitedClusters.add(cluster)

      const offset = clusterToOffset(cluster, boot)
      const clusterData = readSectors(fd, offset, boot.bytesPerCluster)

      let lfnParts: string[] = []

      for (let i = 0; i < clusterData.length; i += DIR_ENTRY_SIZE) {
        const entry = clusterData.subarray(i, i + DIR_ENTRY_SIZE)
        const firstByte = entry[0]

        if (firstByte === 0x00) break

        const attr = entry[11]

        if (attr === ATTR_LONG_NAME) {
          const lfnText = extractLFNPart(entry)
          const seqNum = firstByte & 0x1f
          lfnParts[seqNum - 1] = lfnText
          continue
        }

        if (attr & ATTR_VOLUME_ID) {
          lfnParts = []
          continue
        }

        const shortName = entry.toString('ascii', 0, 8).trim()
        const extension = entry.toString('ascii', 8, 11).trim()
        const isDeleted = firstByte === DELETED_MARKER

        if (attr & ATTR_DIRECTORY) {
          if (shortName !== '.' && shortName !== '..') {
            const dirCluster = extractStartCluster(entry)
            if (dirCluster >= 2) scanDirectory(dirCluster)
          }
          lfnParts = []
          continue
        }

        if (isDeleted && targetExtensions.has(extension.toUpperCase())) {
          const longFileName = lfnParts.length > 0
            ? lfnParts.filter(Boolean).join('')
            : undefined
          const restoredName = '_' + shortName.slice(1)

          entries.push({
            fileName: restoredName,
            extension,
            isDeleted: true,
            startCluster: extractStartCluster(entry),
            fileSize: entry.readUInt32LE(28),
            creationTime: parseFATDateTime(entry.readUInt16LE(16), entry.readUInt16LE(14)),
            modifiedTime: parseFATDateTime(entry.readUInt16LE(24), entry.readUInt16LE(22)),
            longFileName,
            attributes: attr
          })
        }

        lfnParts = []
      }

      scannedCount++
      if (onProgress && scannedCount % 10 === 0) {
        onProgress(scannedCount)
      }

      cluster = getNextCluster(fd, cluster, boot)
    }
  }

  scanDirectory(boot.rootCluster)
  return entries
}

/**
 * exFAT用の削除エントリスキャン。
 * exFATのディレクトリエントリはFAT32と全く異なる形式:
 *  - 0x85 (削除: 0x05) = File Directory Entry
 *  - 0xC0 (削除: 0x40) = Stream Extension Entry (ファイルサイズ・開始クラスタ)
 *  - 0xC1 (削除: 0x41) = File Name Extension Entry (ファイル名UTF-16)
 */
function scanDeletedEntriesExFAT(
  fd: number,
  boot: FATBootSector,
  onProgress?: (scannedClusters: number) => void
): FATDirectoryEntry[] {
  const entries: FATDirectoryEntry[] = []
  const targetExtensions = new Set(['MP4', 'LRV', 'THM'])
  const visitedClusters = new Set<number>()
  let scannedCount = 0

  function scanDirectory(startCluster: number): void {
    let cluster = startCluster

    while (!isEndOfChain(cluster, boot.type) && !isFreeCluster(cluster)) {
      if (visitedClusters.has(cluster)) break
      visitedClusters.add(cluster)

      const offset = clusterToOffset(cluster, boot)
      const clusterData = readSectors(fd, offset, boot.bytesPerCluster)

      // exFATエントリ解析用の状態
      let pendingFileEntry: {
        creationTime: number
        modifiedTime: number
        attributes: number
        isDeleted: boolean
      } | null = null
      let pendingStreamEntry: {
        startCluster: number
        fileSize: number
      } | null = null
      let fileNameParts: string[] = []

      // 完了したエントリセットを処理する共通関数
      const flushPending = () => {
        if (!pendingFileEntry || !pendingStreamEntry) return
        const isDir = (pendingFileEntry.attributes & ATTR_DIRECTORY) !== 0
        if (isDir) {
          // サブディレクトリを再帰スキャン（active/deleted両方）
          if (pendingStreamEntry.startCluster >= 2) {
            scanDirectory(pendingStreamEntry.startCluster)
          }
        } else if (pendingFileEntry.isDeleted) {
          addExFATEntry(entries, pendingFileEntry, pendingStreamEntry, fileNameParts, targetExtensions)
        }
      }

      for (let i = 0; i < clusterData.length; i += DIR_ENTRY_SIZE) {
        const entryType = clusterData[i]

        // エントリ終端
        if (entryType === 0x00) break

        // File Directory Entry (active=0x85, deleted=0x05)
        if (entryType === EXFAT_FILE_ENTRY || entryType === EXFAT_FILE_ENTRY_DELETED) {
          // 前のエントリセットがあれば処理
          flushPending()

          fileNameParts = []
          pendingStreamEntry = null

          // File Directory Entry フォーマット:
          // offset 4: FileAttributes (uint16)
          // offset 8: CreateTimestamp (uint32, exFAT形式)
          // offset 12: LastModifiedTimestamp (uint32)
          const attrs = clusterData.readUInt16LE(i + 4)
          const createTS = clusterData.readUInt32LE(i + 8)
          const modifyTS = clusterData.readUInt32LE(i + 12)

          pendingFileEntry = {
            creationTime: parseExFATTimestamp(createTS),
            modifiedTime: parseExFATTimestamp(modifyTS),
            attributes: attrs,
            isDeleted: entryType === EXFAT_FILE_ENTRY_DELETED
          }
          continue
        }

        // Stream Extension Entry (active=0xC0, deleted=0x40)
        if (entryType === EXFAT_STREAM_EXT || entryType === EXFAT_STREAM_EXT_DELETED) {
          if (!pendingFileEntry) continue

          // Stream Extension フォーマット:
          // offset 20: FirstCluster (uint32)
          // offset 24: DataLength (uint64)
          const firstCluster = clusterData.readUInt32LE(i + 20)
          const dataLength = Number(clusterData.readBigUInt64LE(i + 24))

          pendingStreamEntry = {
            startCluster: firstCluster,
            fileSize: dataLength
          }
          continue
        }

        // File Name Extension Entry (active=0xC1, deleted=0x41)
        if (entryType === EXFAT_FILENAME_EXT || entryType === EXFAT_FILENAME_EXT_DELETED) {
          if (!pendingFileEntry) continue

          // offset 2〜31: 15文字分のUTF-16LE
          const nameBuf = clusterData.subarray(i + 2, i + 32)
          let part = ''
          for (let j = 0; j < 30; j += 2) {
            const code = nameBuf.readUInt16LE(j)
            if (code === 0x0000) break
            part += String.fromCharCode(code)
          }
          fileNameParts.push(part)
          continue
        }
      }

      // クラスタ末尾で未処理のエントリを処理
      flushPending()

      scannedCount++
      if (onProgress && scannedCount % 10 === 0) {
        onProgress(scannedCount)
      }

      cluster = getNextCluster(fd, cluster, boot)
    }
  }

  scanDirectory(boot.rootCluster)
  return entries
}

/** exFATの削除エントリをentriesに追加 */
function addExFATEntry(
  entries: FATDirectoryEntry[],
  fileEntry: { creationTime: number; modifiedTime: number; attributes: number },
  streamEntry: { startCluster: number; fileSize: number },
  fileNameParts: string[],
  targetExtensions: Set<string>
): void {
  const fullName = fileNameParts.join('')
  const ext = fullName.includes('.') ? fullName.split('.').pop()!.toUpperCase() : ''

  if (!targetExtensions.has(ext)) return
  if (streamEntry.startCluster < 2) return

  const baseName = fullName.includes('.') ? fullName.substring(0, fullName.lastIndexOf('.')) : fullName

  entries.push({
    fileName: baseName,
    extension: ext,
    isDeleted: true,
    startCluster: streamEntry.startCluster,
    fileSize: streamEntry.fileSize,
    creationTime: fileEntry.creationTime,
    modifiedTime: fileEntry.modifiedTime,
    longFileName: fullName,
    attributes: fileEntry.attributes
  })
}

/**
 * exFATタイムスタンプをUnix timestamp (ms) に変換する。
 * exFAT timestamp: bits [31:25]=年(+1980), [24:21]=月, [20:16]=日,
 *                  [15:11]=時, [10:5]=分, [4:0]=秒*2
 */
function parseExFATTimestamp(ts: number): number {
  const year = ((ts >> 25) & 0x7f) + 1980
  const month = ((ts >> 21) & 0x0f) - 1
  const day = (ts >> 16) & 0x1f
  const hour = (ts >> 11) & 0x1f
  const minute = (ts >> 5) & 0x3f
  const second = (ts & 0x1f) * 2
  return new Date(year, month, day, hour, minute, second).getTime()
}

/**
 * 開始クラスタ番号を抽出する（上位16bit + 下位16bit）。
 */
function extractStartCluster(entry: Buffer): number {
  const high = entry.readUInt16LE(20)
  const low = entry.readUInt16LE(26)
  return (high << 16) | low
}

/**
 * LFNエントリからUnicode文字列を抽出する。
 */
function extractLFNPart(entry: Buffer): string {
  const chars: number[] = []
  // LFNの文字位置: 1-10, 14-25, 28-31
  const offsets = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
  for (const off of offsets) {
    if (off + 1 >= entry.length) break
    const code = entry.readUInt16LE(off)
    if (code === 0x0000 || code === 0xffff) break
    chars.push(code)
  }
  return String.fromCharCode(...chars)
}

/**
 * FAT日時フォーマットをUnix timestamp (ms) に変換する。
 * FAT date: bits [15:9]=年(+1980), [8:5]=月, [4:0]=日
 * FAT time: bits [15:11]=時, [10:5]=分, [4:0]=秒(/2)
 */
function parseFATDateTime(date: number, time: number): number {
  const year = ((date >> 9) & 0x7f) + 1980
  const month = ((date >> 5) & 0x0f) - 1
  const day = date & 0x1f
  const hour = (time >> 11) & 0x1f
  const minute = (time >> 5) & 0x3f
  const second = (time & 0x1f) * 2

  return new Date(year, month, day, hour, minute, second).getTime()
}

/** クラスタチェーン再構築の結果 */
export interface ClusterChainResult {
  /** クラスタ番号の配列 */
  chain: number[]
  /** チェーンの信頼度 (0.0〜1.0) */
  confidence: number
  /** 連続クラスタ仮定で補完したクラスタ数 */
  assumedContiguous: number
  /** FATエントリから辿れたクラスタ数 */
  fatLinked: number
}

/**
 * 削除済みエントリのクラスタチェーンを再構築する。
 * 削除されたファイルのFATエントリは0クリアされるため、
 * 連続したフリークラスタを開始クラスタから辿って推定する。
 *
 * 信頼度スコア:
 *  - 全クラスタがFATリンクで辿れた → 0.95
 *  - 全クラスタが連続仮定（1クラスタファイル含む） → 0.7
 *  - 混在 → FAT辿り率に基づく 0.4〜0.9
 *  - 途中で非フリークラスタに衝突（他ファイルが上書き） → 0.2
 */
export function rebuildClusterChain(
  fd: number,
  startCluster: number,
  fileSize: number,
  boot: FATBootSector
): ClusterChainResult {
  const clustersNeeded = Math.ceil(fileSize / boot.bytesPerCluster)
  const chain: number[] = []
  let currentCluster = startCluster
  let assumedContiguous = 0
  let fatLinked = 0
  let hitOccupied = false

  for (let i = 0; i < clustersNeeded; i++) {
    chain.push(currentCluster)

    if (i < clustersNeeded - 1) {
      const nextInFAT = getNextCluster(fd, currentCluster, boot)

      if (isFreeCluster(nextInFAT)) {
        // FATエントリが空 = 削除されている → 連続クラスタと仮定
        // ただし次のクラスタも空きか確認
        const nextNextInFAT = getNextCluster(fd, currentCluster + 1, boot)
        if (!isFreeCluster(nextNextInFAT) && !isEndOfChain(nextNextInFAT, boot.type) && i < clustersNeeded - 2) {
          // 次の次が他ファイルに使用中 → 上書きの可能性
          hitOccupied = true
        }
        currentCluster++
        assumedContiguous++
      } else if (!isEndOfChain(nextInFAT, boot.type)) {
        // FATチェーンが生きている（部分的に残存）
        currentCluster = nextInFAT
        fatLinked++
      } else {
        // チェーン終端だがファイルサイズ未達 → 連続で補完
        currentCluster++
        assumedContiguous++
      }
    }
  }

  // 信頼度スコアを算出
  let confidence: number
  const total = clustersNeeded - 1 // 遷移回数

  if (total === 0) {
    // 1クラスタで収まるファイル → チェーン不要なので高信頼
    confidence = 0.95
  } else if (hitOccupied) {
    // 途中で上書きされたクラスタに衝突 → データ破損の可能性が高い
    confidence = 0.2
  } else if (fatLinked === total) {
    // 全クラスタがFATリンクで辿れた
    confidence = 0.95
  } else if (assumedContiguous === total) {
    // 全て連続仮定（GoPro/SDカードでは比較的よくある）
    confidence = 0.7
  } else {
    // FAT辿りと連続仮定の混在
    const fatRatio = fatLinked / total
    confidence = 0.4 + fatRatio * 0.5 // 0.4〜0.9
  }

  return { chain, confidence, assumedContiguous, fatLinked }
}
