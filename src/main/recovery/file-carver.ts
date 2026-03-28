import type { FATBootSector, RecoveredFile, ScanProgress } from './types'
import { readSectors } from './raw-disk'
import {
  isMp4Signature,
  detectCodec,
  getCreationTime,
  estimateFileSize
} from './mp4-parser'

/**
 * ファイルカービングモジュール
 *
 * ディスクをシーケンシャルスキャンし、MP4バイナリシグネチャ（ftyp box）を
 * 検出してファイルを復元する。FAT復元で見つからないファイル向けのPhase 2。
 */

/** スキャン時の読み取りチャンクサイズ (1MB) */
const SCAN_CHUNK_SIZE = 1024 * 1024

/** MP4ヘッダ読み取り最大サイズ (moovを含むために十分な量: 10MB) */
const HEADER_READ_SIZE = 10 * 1024 * 1024

/**
 * ディスク全体をスキャンしてMP4シグネチャを検出する。
 *
 * @param fd ドライブのファイルディスクリプタ
 * @param boot FATブートセクタ情報
 * @param afterDate この日時以降のファイルのみ (Unix timestamp ms)
 * @param knownOffsets FAT復元で既に検出済みのオフセット（重複回避）
 * @param onProgress 進捗コールバック
 * @param abortSignal 中断シグナル
 */
export function carveFiles(
  fd: number,
  boot: FATBootSector,
  afterDate: number,
  knownOffsets: Set<number>,
  onProgress?: (progress: ScanProgress) => void,
  abortSignal?: { aborted: boolean }
): RecoveredFile[] {
  const results: RecoveredFile[] = []
  const totalBytes = boot.totalSectors * boot.bytesPerSector
  const dataStartByte = boot.dataStartSector * boot.bytesPerSector
  let filesFound = 0

  // データ領域のみをスキャン（予約領域・FATテーブルはスキップ）
  let offset = dataStartByte

  while (offset < totalBytes) {
    if (abortSignal?.aborted) break

    // チャンクを読み取り
    const readSize = Math.min(SCAN_CHUNK_SIZE, totalBytes - offset)
    let chunk: Buffer
    try {
      chunk = readSectors(fd, offset, readSize)
    } catch {
      offset += readSize
      continue
    }

    if (chunk.length === 0) break

    // チャンク内でftypシグネチャを検索
    let pos = 0
    while (pos + 8 <= chunk.length) {
      if (isMp4Signature(chunk, pos)) {
        const absoluteOffset = offset + pos

        // 既にFAT復元で検出済みならスキップ
        if (knownOffsets.has(absoluteOffset)) {
          pos += 512 // 次のセクタ境界へ
          continue
        }

        // MP4ヘッダを十分な量読み取る
        const headerBuf = readHeaderSafe(fd, absoluteOffset, totalBytes)
        if (headerBuf) {
          const file = parseCarvedFile(headerBuf, absoluteOffset, afterDate, boot)
          if (file) {
            filesFound++
            file.id = `carve-${filesFound}`
            results.push(file)
          }
        }

        // ftyp boxのサイズ分スキップ
        const ftypSize = chunk.readUInt32BE(pos)
        pos += Math.max(ftypSize, 512)
        continue
      }

      // セクタ境界単位でスキャン（セクタ中間にftypが来ることはまずない）
      pos += 512
    }

    // 進捗報告
    if (onProgress) {
      const currentSector = Math.floor(offset / boot.bytesPerSector)
      onProgress({
        phase: 'carving',
        percent: Math.floor(((offset - dataStartByte) / (totalBytes - dataStartByte)) * 100),
        currentSector,
        totalSectors: boot.totalSectors,
        filesFound
      })
    }

    // 次のチャンク（境界をまたぐケースのためにオーバーラップ）
    offset += readSize - 512
  }

  return results
}

/**
 * ヘッダ部分を安全に読み取る。
 */
function readHeaderSafe(
  fd: number,
  offset: number,
  totalBytes: number
): Buffer | null {
  const readSize = Math.min(HEADER_READ_SIZE, totalBytes - offset)
  if (readSize < 64) return null
  try {
    return readSectors(fd, offset, readSize)
  } catch {
    return null
  }
}

/**
 * カービングで検出したMP4データを解析し、RecoveredFileを構築する。
 */
function parseCarvedFile(
  buf: Buffer,
  diskOffset: number,
  afterDate: number,
  boot: FATBootSector
): RecoveredFile | null {
  // creation_time を取得
  const creationTime = getCreationTime(buf)

  // 日時フィルタ: creation_time が取得でき、かつ afterDate より前なら除外
  if (creationTime !== null && creationTime < afterDate) {
    return null
  }

  // ファイルサイズを推定
  const fileSize = estimateFileSize(buf)
  if (fileSize < 1024) return null // 1KB未満は誤検出として除外

  // コーデック検出
  const codec = detectCodec(buf)

  // クラスタ列を計算
  const startCluster = Math.floor(
    (diskOffset - boot.dataStartSector * boot.bytesPerSector) / boot.bytesPerCluster
  ) + 2
  const clusterCount = Math.ceil(fileSize / boot.bytesPerCluster)
  const clusters: number[] = []
  for (let i = 0; i < clusterCount; i++) {
    clusters.push(startCluster + i)
  }

  // ファイル名を生成（タイムスタンプベース）
  const dateStr = creationTime
    ? formatDateForFileName(creationTime)
    : `offset_${diskOffset.toString(16)}`
  const fileName = `RECOVERED_${dateStr}.MP4`

  return {
    id: '',
    fileName,
    creationTime: creationTime ?? 0,
    fileSize,
    codec,
    recoveryMethod: 'file-carving',
    diskOffset,
    clusters,
    confidence: creationTime !== null ? 0.7 : 0.4
  }
}

function formatDateForFileName(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
