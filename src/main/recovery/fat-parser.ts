import type { FATBootSector, FATDirectoryEntry } from './types'
import { readSectors, readSectorRange } from './raw-disk'

/**
 * FAT32/exFAT パーサー
 *
 * SDカードのブートセクタを解析し、削除済みディレクトリエントリを検出する。
 */

/** 削除済みエントリのマーカー (0xE5) */
const DELETED_MARKER = 0xe5

/** ディレクトリエントリのサイズ (32 bytes) */
const DIR_ENTRY_SIZE = 32

/** LFNエントリの属性値 */
const ATTR_LONG_NAME = 0x0f

/** 属性: ディレクトリ */
const ATTR_DIRECTORY = 0x10

/** 属性: ボリュームラベル */
const ATTR_VOLUME_ID = 0x08

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
  const reservedSectors = buf.readUInt32LE(40) // FATオフセット（セクタ単位）
  const numberOfFATs = buf.readUInt8(110)
  const sectorsPerFAT = buf.readUInt32LE(44)
  const rootCluster = buf.readUInt32LE(96)
  const totalSectors = Number(buf.readBigUInt64LE(72))
  const dataStartSector = buf.readUInt32LE(88) // クラスタヒープオフセット

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
 * FATテーブルから次のクラスタを読み取る（FAT32）。
 */
export function getNextCluster(
  fd: number,
  cluster: number,
  boot: FATBootSector
): number {
  if (boot.type === 'FAT32') {
    const fatOffset = cluster * 4
    const fatSector = boot.reservedSectors + Math.floor(fatOffset / boot.bytesPerSector)
    const entryOffset = fatOffset % boot.bytesPerSector
    const buf = readSectors(fd, fatSector * boot.bytesPerSector, boot.bytesPerSector)
    const nextCluster = buf.readUInt32LE(entryOffset) & 0x0fffffff
    return nextCluster
  }
  // exFAT: 4バイトエントリ
  const fatOffset = cluster * 4
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
 * 対象拡張子: MP4, LRV, THM
 */
export function scanDeletedEntries(
  fd: number,
  boot: FATBootSector,
  onProgress?: (scannedClusters: number) => void
): FATDirectoryEntry[] {
  const entries: FATDirectoryEntry[] = []
  const targetExtensions = new Set(['MP4', 'LRV', 'THM'])

  // ルートディレクトリから開始して再帰的にスキャン
  const visitedClusters = new Set<number>()
  let scannedCount = 0

  function scanDirectory(startCluster: number): void {
    let cluster = startCluster

    while (!isEndOfChain(cluster, boot.type) && !isFreeCluster(cluster)) {
      if (visitedClusters.has(cluster)) break
      visitedClusters.add(cluster)

      const offset = clusterToOffset(cluster, boot)
      const clusterData = readSectors(fd, offset, boot.bytesPerCluster)

      // LFN (Long File Name) バッファ
      let lfnParts: string[] = []

      for (let i = 0; i < clusterData.length; i += DIR_ENTRY_SIZE) {
        const entry = clusterData.subarray(i, i + DIR_ENTRY_SIZE)
        const firstByte = entry[0]

        // エントリ終端
        if (firstByte === 0x00) break

        const attr = entry[11]

        // LFNエントリの処理
        if (attr === ATTR_LONG_NAME) {
          const lfnText = extractLFNPart(entry)
          const seqNum = firstByte & 0x1f
          lfnParts[seqNum - 1] = lfnText
          continue
        }

        // ボリュームラベルはスキップ
        if (attr & ATTR_VOLUME_ID) {
          lfnParts = []
          continue
        }

        // 8.3ファイル名を取得
        const shortName = entry.toString('ascii', 0, 8).trim()
        const extension = entry.toString('ascii', 8, 11).trim()
        const isDeleted = firstByte === DELETED_MARKER

        // ディレクトリの場合は再帰スキャン（. と .. はスキップ）
        if (attr & ATTR_DIRECTORY) {
          if (shortName !== '.' && shortName !== '..') {
            const dirCluster = extractStartCluster(entry)
            if (dirCluster >= 2) {
              scanDirectory(dirCluster)
            }
          }
          lfnParts = []
          continue
        }

        // 削除済みで対象拡張子のファイルを収集
        if (isDeleted && targetExtensions.has(extension.toUpperCase())) {
          const longFileName = lfnParts.length > 0
            ? lfnParts.filter(Boolean).join('')
            : undefined

          // 削除されたファイル名の最初の文字を復元（不明なので_にする）
          const restoredName = '_' + shortName.slice(1)

          entries.push({
            fileName: restoredName,
            extension,
            isDeleted: true,
            startCluster: extractStartCluster(entry),
            fileSize: entry.readUInt32LE(28),
            creationTime: parseFATDateTime(
              entry.readUInt16LE(16),
              entry.readUInt16LE(14)
            ),
            modifiedTime: parseFATDateTime(
              entry.readUInt16LE(24),
              entry.readUInt16LE(22)
            ),
            longFileName,
            attributes: attr
          })
        }

        lfnParts = []
      }

      scannedCount++
      if (onProgress && scannedCount % 100 === 0) {
        onProgress(scannedCount)
      }

      cluster = getNextCluster(fd, cluster, boot)
    }
  }

  scanDirectory(boot.rootCluster)
  return entries
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

/**
 * 削除済みエントリのクラスタチェーンを再構築する。
 * 削除されたファイルのFATエントリは0クリアされるため、
 * 連続したフリークラスタを開始クラスタから辿って推定する。
 */
export function rebuildClusterChain(
  fd: number,
  startCluster: number,
  fileSize: number,
  boot: FATBootSector
): number[] {
  const clustersNeeded = Math.ceil(fileSize / boot.bytesPerCluster)
  const chain: number[] = []
  let currentCluster = startCluster

  for (let i = 0; i < clustersNeeded; i++) {
    chain.push(currentCluster)

    if (i < clustersNeeded - 1) {
      // 次のクラスタのFATエントリを確認
      const nextInFAT = getNextCluster(fd, currentCluster, boot)

      if (isFreeCluster(nextInFAT)) {
        // FATエントリが空 = 削除されている → 連続クラスタと仮定
        currentCluster++
      } else if (!isEndOfChain(nextInFAT, boot.type)) {
        // まだチェーンが残っている（部分的に上書きされたケース）
        currentCluster = nextInFAT
      } else {
        // チェーン終端に達したが、まだファイルサイズ分のクラスタが足りない
        // 連続クラスタで補完
        currentCluster++
      }
    }
  }

  return chain
}
