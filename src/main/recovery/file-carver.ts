import type { FATBootSector, RecoveredFile, ScanProgress } from './types.js'
import { readSectors } from './raw-disk.js'
import {
  isMp4Signature,
  detectCodec,
  getCreationTime,
  estimateFileSize,
  estimateFileSizeWithMoov
} from './mp4-parser.js'

/**
 * ファイルカービングモジュール
 *
 * ディスクをシーケンシャルスキャンし、MP4バイナリシグネチャ（ftyp box）を
 * 検出してファイルを復元する。FAT復元で見つからないファイル向けのPhase 2。
 */

/** スキャン時の読み取りチャンクサイズ (32MB) — プロセス起動回数を削減 */
const SCAN_CHUNK_SIZE = 32 * 1024 * 1024

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
export async function carveFiles(
  fd: number,
  boot: FATBootSector,
  afterDate: number,
  knownOffsets: Set<number>,
  onProgress?: (progress: ScanProgress) => void,
  abortSignal?: { aborted: boolean }
): Promise<RecoveredFile[]> {
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
          pos += 512
          continue
        }

        // チャンク内の残りデータを可能な限り再利用し、不足分のみ追加読み取り
        const remainingInChunk = chunk.length - pos
        let headerBuf: Buffer | null
        if (remainingInChunk >= HEADER_READ_SIZE) {
          headerBuf = chunk.subarray(pos, pos + HEADER_READ_SIZE)
        } else if (remainingInChunk >= 64) {
          // チャンクの残り + 追加読み取りを結合
          const extra = readHeaderSafe(fd, absoluteOffset + remainingInChunk, totalBytes,
            HEADER_READ_SIZE - remainingInChunk)
          if (extra) {
            headerBuf = Buffer.concat([chunk.subarray(pos), extra])
          } else {
            headerBuf = chunk.subarray(pos)
          }
        } else {
          headerBuf = readHeaderSafe(fd, absoluteOffset, totalBytes, HEADER_READ_SIZE)
        }

        if (headerBuf) {
          const file = parseCarvedFile(headerBuf, absoluteOffset, afterDate, boot, fd, totalBytes)
          if (file) {
            filesFound++
            file.id = `carve-${filesFound}`
            results.push(file)
          }
        }

        // ftyp boxのサイズ分スキップ（妥当な範囲に制限）
        const ftypSize = chunk.readUInt32BE(pos)
        const skip = (ftypSize >= 20 && ftypSize <= 1024 * 1024)
          ? ftypSize
          : 512
        pos += Math.min(skip, chunk.length - pos)
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

    // イベントループに制御を戻す（SSE進捗送信のため）
    await new Promise(resolve => setTimeout(resolve, 0))

    // 次のチャンク（境界をまたぐケースのためにオーバーラップ、ただし最終チャンクは例外）
    offset += readSize > 512 ? readSize - 512 : readSize
  }

  return results
}

/**
 * ヘッダ部分を安全に読み取る。
 */
function readHeaderSafe(
  fd: number,
  offset: number,
  totalBytes: number,
  maxSize: number = HEADER_READ_SIZE
): Buffer | null {
  const readSize = Math.min(maxSize, totalBytes - offset)
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
  boot: FATBootSector,
  fd: number,
  totalBytes: number
): RecoveredFile | null {
  // creation_time を取得
  const creationTime = getCreationTime(buf)

  // 日時フィルタ: creation_time が取得でき、かつ afterDate より前なら除外
  if (creationTime !== null && creationTime < afterDate) {
    return null
  }

  // ファイルサイズを推定（ftyp+mdat）
  let fileSize = estimateFileSize(buf)
  if (fileSize < 1024) return null // 1KB未満は誤検出として除外

  // moovをヘッダバッファ内（fast-start）またはmdat直後（通常配置）で探す
  const hasMoovInHeader = getCreationTime(buf) !== null
  const baseSizeBeforeMoov = fileSize

  if (!hasMoovInHeader) {
    // mdat直後のディスク位置を読んでmoovを探す（GoPro: moovがファイル末尾）
    fileSize = estimateFileSizeWithMoov(fileSize, (probeOffset, probeLen) => {
      const absOffset = diskOffset + probeOffset
      if (absOffset + probeLen > totalBytes) return null
      try {
        return readSectors(fd, absOffset, probeLen)
      } catch {
        return null
      }
    })
  }

  const hasMoov = hasMoovInHeader || fileSize > baseSizeBeforeMoov

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

  // ファイル名を生成
  const dateStr = creationTime
    ? formatDateForFileName(creationTime)
    : `offset_${diskOffset.toString(16)}`
  const moovTag = hasMoov ? '' : '_NO_MOOV'
  const fileName = `RECOVERED_${dateStr}${moovTag}.MP4`

  return {
    id: '',
    fileName,
    creationTime: creationTime ?? 0,
    fileSize,
    codec,
    recoveryMethod: 'file-carving',
    diskOffset,
    clusters,
    // moovなし → 再生不可能（0.1）、moovあり+日時あり → 0.8、moovあり+日時なし → 0.5
    confidence: hasMoov ? (creationTime !== null ? 0.8 : 0.5) : 0.1
  }
}

function formatDateForFileName(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
