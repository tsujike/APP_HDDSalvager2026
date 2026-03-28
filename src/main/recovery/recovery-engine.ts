import * as fs from 'fs'
import * as path from 'path'
import type {
  RecoveredFile,
  RecoveryOptions,
  ScanProgress,
  FATBootSector
} from './types'
import { openDrive, closeDrive, readSectors } from './raw-disk'
import { parseBootSector, scanDeletedEntries, rebuildClusterChain, clusterToOffset } from './fat-parser'
import { getCreationTime, detectCodec } from './mp4-parser'
import { carveFiles } from './file-carver'

/**
 * リカバリーエンジン
 *
 * Phase 1 (FAT削除エントリ復元) と Phase 2 (ファイルカービング) を
 * オーケストレーションし、検出されたファイルの復元を行う。
 */

export class RecoveryEngine {
  private fd: number | null = null
  private boot: FATBootSector | null = null
  private abortSignal = { aborted: false }

  /**
   * SDカードをスキャンし、復元可能な動画ファイルを検出する。
   */
  async scan(
    options: RecoveryOptions,
    onProgress: (progress: ScanProgress) => void
  ): Promise<RecoveredFile[]> {
    this.abortSignal = { aborted: false }
    const allFiles: RecoveredFile[] = []

    try {
      // ドライブをオープン
      this.fd = openDrive(options.drive.physicalDrive)
      this.boot = parseBootSector(this.fd)

      // === Phase 1: FAT削除エントリ復元 ===
      onProgress({
        phase: 'fat-scan',
        percent: 0,
        currentSector: 0,
        totalSectors: this.boot.totalSectors,
        filesFound: 0
      })

      const deletedEntries = scanDeletedEntries(
        this.fd,
        this.boot,
        (scanned) => {
          onProgress({
            phase: 'fat-scan',
            percent: Math.min(95, Math.floor(scanned / 10)),
            currentSector: scanned,
            totalSectors: this.boot!.totalSectors,
            filesFound: allFiles.length
          })
        }
      )

      // 削除エントリからRecoveredFileを構築
      const knownOffsets = new Set<number>()
      let fatFileCount = 0

      for (const entry of deletedEntries) {
        if (this.abortSignal.aborted) break
        if (entry.extension.toUpperCase() !== 'MP4') continue

        // クラスタチェーンを再構築
        const clusters = rebuildClusterChain(
          this.fd,
          entry.startCluster,
          entry.fileSize,
          this.boot
        )

        // 先頭クラスタのオフセット
        const diskOffset = clusterToOffset(entry.startCluster, this.boot)
        knownOffsets.add(diskOffset)

        // MP4ヘッダからcreation_timeを取得（FATのタイムスタンプより正確）
        let creationTime = entry.creationTime
        const headerSize = Math.min(10 * 1024 * 1024, entry.fileSize)
        try {
          const headerBuf = readSectors(this.fd, diskOffset, headerSize)
          const mp4Time = getCreationTime(headerBuf)
          if (mp4Time !== null) {
            creationTime = mp4Time
          }
        } catch {
          // ヘッダ読み取り失敗時はFATのタイムスタンプを使用
        }

        // 日時フィルタ
        if (creationTime < options.afterDate) continue

        // コーデック検出
        let codec: RecoveredFile['codec'] = 'unknown'
        try {
          const ftypBuf = readSectors(this.fd, diskOffset, 64)
          codec = detectCodec(ftypBuf)
        } catch {
          // 検出失敗
        }

        fatFileCount++
        const fileName = entry.longFileName || `${entry.fileName}.${entry.extension}`

        allFiles.push({
          id: `fat-${fatFileCount}`,
          fileName,
          creationTime,
          fileSize: entry.fileSize,
          codec,
          recoveryMethod: 'fat-entry',
          diskOffset,
          clusters,
          confidence: 0.9
        })
      }

      onProgress({
        phase: 'fat-scan',
        percent: 100,
        currentSector: this.boot.totalSectors,
        totalSectors: this.boot.totalSectors,
        filesFound: allFiles.length
      })

      // === Phase 2: ファイルカービング ===
      if (options.enableCarving && !this.abortSignal.aborted) {
        const carvedFiles = carveFiles(
          this.fd,
          this.boot,
          options.afterDate,
          knownOffsets,
          onProgress,
          this.abortSignal
        )
        allFiles.push(...carvedFiles)
      }

      onProgress({
        phase: 'complete',
        percent: 100,
        currentSector: this.boot.totalSectors,
        totalSectors: this.boot.totalSectors,
        filesFound: allFiles.length
      })

      return allFiles
    } finally {
      if (this.fd !== null) {
        closeDrive(this.fd)
        this.fd = null
      }
    }
  }

  /**
   * 検出されたファイルを指定フォルダに復元（コピー）する。
   */
  async recover(
    files: RecoveredFile[],
    drive: string,
    outputDir: string,
    onProgress: (current: number, total: number, fileName: string) => void
  ): Promise<{ succeeded: string[]; failed: { fileName: string; error: string }[] }> {
    const succeeded: string[] = []
    const failed: { fileName: string; error: string }[] = []

    // 出力ディレクトリを作成
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    let fd: number | null = null
    try {
      fd = openDrive(drive)

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        onProgress(i + 1, files.length, file.fileName)

        try {
          // 出力ファイルパス（重複回避）
          const outputPath = getUniqueFilePath(outputDir, file.fileName)

          // クラスタからデータを読み取ってファイルに書き出し
          const writeStream = fs.createWriteStream(outputPath)
          let bytesWritten = 0

          const boot = parseBootSector(fd)

          for (const cluster of file.clusters) {
            const offset = clusterToOffset(cluster, boot)
            const readSize = Math.min(
              boot.bytesPerCluster,
              file.fileSize - bytesWritten
            )
            if (readSize <= 0) break

            const data = readSectors(fd, offset, readSize)
            writeStream.write(data)
            bytesWritten += data.length
          }

          writeStream.end()
          await new Promise<void>((resolve, reject) => {
            writeStream.on('finish', resolve)
            writeStream.on('error', reject)
          })

          succeeded.push(outputPath)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          failed.push({ fileName: file.fileName, error: message })
        }
      }
    } finally {
      if (fd !== null) {
        closeDrive(fd)
      }
    }

    return { succeeded, failed }
  }

  /**
   * スキャンを中断する。
   */
  abort(): void {
    this.abortSignal.aborted = true
  }
}

/**
 * 重複しないファイルパスを生成する。
 */
function getUniqueFilePath(dir: string, fileName: string): string {
  let filePath = path.join(dir, fileName)
  if (!fs.existsSync(filePath)) return filePath

  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let counter = 1

  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${base}_${counter}${ext}`)
    counter++
  }

  return filePath
}
