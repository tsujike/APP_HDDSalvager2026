import { execSync } from 'child_process'
import * as fs from 'fs'
import type { DriveInfo } from './types'

/**
 * Windows rawディスク読み取りモジュール
 *
 * \\.\PhysicalDriveN を直接openしてセクタ単位で読み取る。
 * 管理者権限が必要。
 */

const SECTOR_SIZE = 512

/**
 * 物理ドライブをオープンし、セクタ読み取り用のfdを返す。
 * Node.js の fs.openSync は \\.\PhysicalDriveN に対してもread可能。
 */
export function openDrive(physicalDrive: string): number {
  try {
    return fs.openSync(physicalDrive, 'r')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('EACCES') || message.includes('EPERM')) {
      throw new Error(
        `管理者権限が必要です。アプリを管理者として実行してください。\n詳細: ${message}`
      )
    }
    throw new Error(`ドライブを開けません: ${physicalDrive}\n詳細: ${message}`)
  }
}

/**
 * 指定オフセットから指定バイト数を読み取る。
 * 読み取りはセクタ境界にアラインされる。
 */
export function readSectors(
  fd: number,
  offsetBytes: number,
  lengthBytes: number
): Buffer {
  const buf = Buffer.alloc(lengthBytes)
  const bytesRead = fs.readSync(fd, buf, 0, lengthBytes, offsetBytes)
  if (bytesRead < lengthBytes) {
    return buf.subarray(0, bytesRead)
  }
  return buf
}

/**
 * 指定セクタ番号から指定セクタ数分を読み取る。
 */
export function readSectorRange(
  fd: number,
  startSector: number,
  sectorCount: number,
  bytesPerSector: number = SECTOR_SIZE
): Buffer {
  const offset = startSector * bytesPerSector
  const length = sectorCount * bytesPerSector
  return readSectors(fd, offset, length)
}

/**
 * ドライブを閉じる。
 */
export function closeDrive(fd: number): void {
  fs.closeSync(fd)
}

/**
 * 接続されたリムーバブルドライブの一覧を取得する。
 * WMICを使用してUSB接続のリムーバブルディスクを列挙。
 */
export function listRemovableDrives(): DriveInfo[] {
  try {
    // PowerShellでリムーバブルドライブを列挙
    const psScript = `
      Get-WmiObject Win32_DiskDrive | Where-Object { $_.MediaType -like '*removable*' -or $_.MediaType -like '*external*' -or $_.InterfaceType -eq 'USB' } | ForEach-Object {
        $disk = $_
        $partitions = Get-WmiObject -Query "ASSOCIATORS OF {Win32_DiskDrive.DeviceID='$($disk.DeviceID.Replace("\\","\\\\"))'} WHERE AssocClass=Win32_DiskDriveToDiskPartition"
        foreach ($part in $partitions) {
          $logicals = Get-WmiObject -Query "ASSOCIATORS OF {Win32_DiskPartition.DeviceID='$($part.DeviceID)'} WHERE AssocClass=Win32_LogicalDiskToPartition"
          foreach ($logical in $logicals) {
            [PSCustomObject]@{
              Letter = $logical.DeviceID
              Label = $logical.VolumeName
              Size = $logical.Size
              FileSystem = $logical.FileSystem
              PhysicalDrive = $disk.DeviceID
              DeviceName = $disk.Model
            } | ConvertTo-Json -Compress
          }
        }
      }
    `.trim()

    const output = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 15000
    }).trim()

    if (!output) return []

    const drives: DriveInfo[] = []
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed)
        drives.push({
          letter: obj.Letter || '',
          label: obj.Label || '',
          totalSize: parseInt(obj.Size) || 0,
          fileSystem: detectFileSystem(obj.FileSystem),
          physicalDrive: obj.PhysicalDrive || '',
          deviceName: obj.DeviceName || ''
        })
      } catch {
        // JSONパース失敗は無視
      }
    }
    return drives
  } catch {
    return []
  }
}

/**
 * ドライブレターから物理ドライブパスを取得する。
 */
export function getPhysicalDrivePath(driveLetter: string): string {
  try {
    const letter = driveLetter.replace(':', '').replace('\\', '')
    const psScript = `
      $part = Get-WmiObject -Query "ASSOCIATORS OF {Win32_LogicalDisk.DeviceID='${letter}:'} WHERE AssocClass=Win32_LogicalDiskToPartition"
      if ($part) {
        $disk = Get-WmiObject -Query "ASSOCIATORS OF {Win32_DiskPartition.DeviceID='$($part.DeviceID)'} WHERE AssocClass=Win32_DiskDriveToDiskPartition"
        if ($disk) { $disk.DeviceID }
      }
    `.trim()
    const output = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000
    }).trim()
    return output || `\\\\.\\${letter}:`
  } catch {
    const letter = driveLetter.replace(':', '').replace('\\', '')
    return `\\\\.\\${letter}:`
  }
}

function detectFileSystem(fsName: string | undefined): DriveInfo['fileSystem'] {
  if (!fsName) return 'unknown'
  const upper = fsName.toUpperCase()
  if (upper.includes('FAT32')) return 'FAT32'
  if (upper.includes('EXFAT')) return 'exFAT'
  return 'unknown'
}

/**
 * ドライブの総セクタ数を取得する。
 */
export function getDriveSectorCount(
  fd: number,
  bytesPerSector: number = SECTOR_SIZE
): number {
  // ブートセクタからtotalSectorsを読む方が正確だが、
  // ここではフォールバックとしてファイルサイズベースで推定
  try {
    const stats = fs.fstatSync(fd)
    if (stats.size > 0) {
      return Math.floor(stats.size / bytesPerSector)
    }
  } catch {
    // 物理ドライブの場合fstatが使えないことがある
  }
  // 物理ドライブの場合はブートセクタから取得する
  return 0
}
