import { execSync, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import type { DriveInfo } from './types.js'

/**
 * rawディスク読み取りモジュール
 *
 * Windows: Node.jsのfs.readSyncはデバイスパスに非対応のため、
 *          disk-reader.exe (Win32 CreateFile/ReadFile) を単発実行して読み取る。
 *          バイナリデータを直接stdoutに返すため高速。
 * Linux:   fs.openSync/readSync で直接アクセス。
 */

const SECTOR_SIZE = 512

/** 仮想fd → ドライブパス (Windows用) */
const winDrives = new Map<number, string>()
let nextFd = 10000

/** disk-reader.exe のパスを解決 */
let diskReaderExePath: string | null = null
function getDiskReaderExe(): string {
  if (diskReaderExePath) return diskReaderExePath
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(__dirname, '../../../../tools/disk-reader.exe'),
    path.resolve(__dirname, '../../../tools/disk-reader.exe'),
    path.resolve(__dirname, '../../tools/disk-reader.exe'),
    path.resolve(process.cwd(), 'tools/disk-reader.exe'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) { diskReaderExePath = p; return p }
  }
  throw new Error('disk-reader.exe が見つかりません。tools/ ディレクトリを確認してください。')
}

/**
 * 物理ドライブをオープンし、読み取り用ハンドル(fd)を返す。
 */
export function openDrive(physicalDrive: string): number {
  if (process.platform === 'win32') {
    // テスト読み取りで開けるか確認
    try {
      winReadBytes(physicalDrive, 0, SECTOR_SIZE)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('error 5') || msg.includes('Access')) {
        throw new Error(`管理者権限が必要です。アプリを管理者として実行してください。`)
      }
      throw new Error(`ドライブを開けません: ${physicalDrive}\n詳細: ${msg}`)
    }
    const fd = nextFd++
    winDrives.set(fd, physicalDrive)
    return fd
  }

  // Linux
  try {
    return fs.openSync(physicalDrive, 'r')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('EACCES') || message.includes('EPERM')) {
      throw new Error(`管理者権限が必要です。\n詳細: ${message}`)
    }
    throw new Error(`ドライブを開けません: ${physicalDrive}\n詳細: ${message}`)
  }
}

/**
 * 指定オフセットから指定バイト数を読み取る。
 */
export function readSectors(
  fd: number,
  offsetBytes: number,
  lengthBytes: number
): Buffer {
  if (lengthBytes <= 0) return Buffer.alloc(0)

  const drivePath = winDrives.get(fd)
  if (drivePath) {
    return winReadBytes(drivePath, offsetBytes, lengthBytes)
  }

  // Linux: セクタ境界にアラインして読み取り
  const alignedOffset = Math.floor(offsetBytes / SECTOR_SIZE) * SECTOR_SIZE
  const headPadding = offsetBytes - alignedOffset
  const alignedLength = Math.ceil((headPadding + lengthBytes) / SECTOR_SIZE) * SECTOR_SIZE

  const buf = Buffer.alloc(alignedLength)
  const bytesRead = fs.readSync(fd, buf, 0, alignedLength, alignedOffset)

  const end = Math.min(headPadding + lengthBytes, bytesRead)
  if (end <= headPadding) return Buffer.alloc(0)
  return buf.subarray(headPadding, end)
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
  return readSectors(fd, startSector * bytesPerSector, sectorCount * bytesPerSector)
}

/**
 * ドライブを閉じる。
 */
export function closeDrive(fd: number): void {
  if (winDrives.has(fd)) {
    winDrives.delete(fd)
    return
  }
  fs.closeSync(fd)
}

/**
 * Windows: disk-reader.exe を単発実行してバイナリデータを取得。
 * EXEはセクタアラインメントとWin32 API呼び出しを内部で処理する。
 */
function winReadBytes(drivePath: string, offset: number, length: number): Buffer {
  const exe = getDiskReaderExe()
  try {
    const result = execFileSync(exe, [drivePath, offset.toString(), length.toString()], {
      encoding: 'buffer',
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024
    })
    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`ディスク読み取りエラー (offset=${offset}): ${msg}`)
  }
}

/**
 * 接続されたリムーバブルドライブの一覧を取得する。
 * Windows: WMI/PowerShell を使用
 * Linux: lsblk を使用
 */
export function listRemovableDrives(): DriveInfo[] {
  if (process.platform === 'win32') {
    return listRemovableDrivesWindows()
  } else {
    return listRemovableDrivesLinux()
  }
}

/**
 * Windows: PowerShellでリムーバブルドライブを列挙。
 * Get-Disk + Get-Partition + Get-Volume を使用（WMI ASSOCIATORSのエスケープ問題を回避）。
 * BusType判定: USB, SD, MMC は確実。SCSI/RAID は FriendlyName に
 * 'Card Reader' 等が含まれる場合のみ対象（内蔵カードリーダー対応）。
 */
function listRemovableDrivesWindows(): DriveInfo[] {
  try {
    const psScript = `
Get-Disk | Where-Object {
  $_.BusType -eq 'USB' -or
  $_.BusType -eq 'SD' -or
  $_.BusType -eq 'MMC' -or
  ($_.BusType -eq 'SCSI' -and $_.FriendlyName -match 'Card Reader|SD|MMC|SDXC|SDHC')
} | ForEach-Object {
  $disk = $_
  Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue |
    Where-Object { $_.DriveLetter } |
    ForEach-Object {
      $vol = Get-Volume -DriveLetter $_.DriveLetter -ErrorAction SilentlyContinue
      if ($vol) {
        [PSCustomObject]@{
          Letter       = $_.DriveLetter + ':'
          Label        = $vol.FileSystemLabel
          Size         = $vol.Size
          FileSystem   = $vol.FileSystem
          PhysicalDrive = '\\\\.\\' + $_.DriveLetter + ':'
          DeviceName   = $disk.FriendlyName
        } | ConvertTo-Json -Compress
      }
    }
}
`
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
    const output = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
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
 * Linux: lsblk でリムーバブルドライブを列挙
 */
function listRemovableDrivesLinux(): DriveInfo[] {
  try {
    // lsblk -J -o NAME,SIZE,FSTYPE,LABEL,TYPE,RM,MOUNTPOINT でJSON形式出力
    const output = execSync('lsblk -J -b -o NAME,SIZE,FSTYPE,LABEL,TYPE,RM,MOUNTPOINT', {
      encoding: 'utf-8',
      timeout: 10000
    }).trim()

    if (!output) return []

    const parsed = JSON.parse(output)
    const drives: DriveInfo[] = []

    // blockdevices の中からリムーバブル(RM=1)かつパーティションを持つものを抽出
    for (const device of parsed.blockdevices || []) {
      // RM=1 (removable) のディスクをチェック
      if (device.rm !== '1' && device.rm !== 1) continue
      if (device.type !== 'disk') continue

      // パーティションを走査
      for (const part of device.children || []) {
        if (part.type !== 'part') continue

        const mountpoint = part.mountpoint || ''
        const letter = mountpoint || `/dev/${part.name}`
        const label = part.label || ''
        const size = parseInt(part.size) || 0
        const fstype = part.fstype || ''

        drives.push({
          letter,
          label,
          totalSize: size,
          fileSystem: detectFileSystem(fstype),
          physicalDrive: `/dev/${device.name}`,
          deviceName: device.name || ''
        })
      }

      // パーティションがない場合はディスク全体
      if (!device.children || device.children.length === 0) {
        drives.push({
          letter: `/dev/${device.name}`,
          label: device.label || '',
          totalSize: parseInt(device.size) || 0,
          fileSystem: detectFileSystem(device.fstype),
          physicalDrive: `/dev/${device.name}`,
          deviceName: device.name || ''
        })
      }
    }

    return drives
  } catch {
    return []
  }
}

/**
 * ドライブレターから物理ドライブパスを取得する。
 * Windows: WMI経由で物理ドライブを取得
 * Linux: パーティション名から親ディスクを取得
 */
export function getPhysicalDrivePath(driveLetter: string): string {
  if (process.platform === 'win32') {
    try {
      const letter = driveLetter.replace(':', '').replace('\\', '')
      const psScript = `
$part = Get-WmiObject -Query "ASSOCIATORS OF {Win32_LogicalDisk.DeviceID='${letter}:'} WHERE AssocClass=Win32_LogicalDiskToPartition"
if ($part) {
  $disk = Get-WmiObject -Query "ASSOCIATORS OF {Win32_DiskPartition.DeviceID='$($part.DeviceID)'} WHERE AssocClass=Win32_DiskDriveToDiskPartition"
  if ($disk) { $disk.DeviceID }
}
`
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
      const output = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        encoding: 'utf-8',
        timeout: 10000
      }).trim()
      return output || `\\\\.\\${letter}:`
    } catch {
      const letter = driveLetter.replace(':', '').replace('\\', '')
      return `\\\\.\\${letter}:`
    }
  } else {
    // Linux: /dev/sda1 → /dev/sda のような変換
    // パーティション番号を除去
    return driveLetter.replace(/\d+$/, '')
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
