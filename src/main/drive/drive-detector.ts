import type { DriveInfo } from '../recovery/types.js'
import { listRemovableDrives } from '../recovery/raw-disk.js'

/**
 * ドライブ検出モジュール
 *
 * システムに接続されたリムーバブルドライブ（SDカード等）を検出し、
 * ドライブ情報を返す。
 */

/**
 * リムーバブルドライブの一覧を取得する。
 * 結果はドライブレター順にソートされる。
 */
export function detectDrives(): DriveInfo[] {
  const drives = listRemovableDrives()
  return drives.sort((a, b) => a.letter.localeCompare(b.letter))
}

/**
 * 指定ドライブがSDカードとして妥当かどうかを簡易チェックする。
 * - FAT32 または exFAT であること
 * - 容量が 1GB 以上 1TB 以下であること
 */
export function isValidSDCard(drive: DriveInfo): boolean {
  const validFS = drive.fileSystem === 'FAT32' || drive.fileSystem === 'exFAT'
  const validSize = drive.totalSize >= 1e9 && drive.totalSize <= 1e12
  return validFS && validSize
}

/**
 * 容量を人間が読みやすい形式にフォーマットする。
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(1)} ${units[i]}`
}
