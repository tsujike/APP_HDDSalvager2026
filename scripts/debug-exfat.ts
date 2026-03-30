/**
 * exFAT ルートディレクトリエントリのデバッグダンプ
 * Usage: npx tsx scripts/debug-exfat.ts J:
 */
import { openDrive, readSectors, closeDrive } from '../src/main/recovery/raw-disk.js'
import { parseBootSector, clusterToOffset } from '../src/main/recovery/fat-parser.js'

const driveLetter = process.argv[2]
if (!driveLetter) {
  console.error('Usage: npx tsx scripts/debug-exfat.ts J:')
  process.exit(1)
}

const physicalDrive = `\\\\.\\${driveLetter.replace(':', '')}:`
console.log(`Opening drive: ${physicalDrive}`)

const fd = openDrive(physicalDrive)
console.log(`Drive opened (fd=${fd})`)

const boot = parseBootSector(fd)
console.log('\n=== Boot Sector ===')
console.log(`  Type: ${boot.type}`)
console.log(`  Bytes/Sector: ${boot.bytesPerSector}`)
console.log(`  Sectors/Cluster: ${boot.sectorsPerCluster}`)
console.log(`  Bytes/Cluster: ${boot.bytesPerCluster}`)
console.log(`  Reserved Sectors: ${boot.reservedSectors}`)
console.log(`  FATs: ${boot.numberOfFATs}`)
console.log(`  Sectors/FAT: ${boot.sectorsPerFAT}`)
console.log(`  Root Cluster: ${boot.rootCluster}`)
console.log(`  Total Sectors: ${boot.totalSectors}`)
console.log(`  Data Start Sector: ${boot.dataStartSector}`)

// ルートディレクトリのクラスタを読む
const rootOffset = clusterToOffset(boot.rootCluster, boot)
console.log(`\nRoot directory offset: ${rootOffset} (0x${rootOffset.toString(16)})`)

// 複数クラスタ読む（ルートディレクトリが大きい場合）
const clustersToRead = 4
const readSize = boot.bytesPerCluster * clustersToRead
const rootData = readSectors(fd, rootOffset, readSize)

console.log(`Read ${rootData.length} bytes from root directory\n`)
console.log('=== Directory Entries ===')

const entryTypeNames: Record<number, string> = {
  0x81: 'Allocation Bitmap',
  0x82: 'Up-case Table',
  0x83: 'Volume Label',
  0x85: 'File (active)',
  0x05: 'File (DELETED)',
  0xC0: 'Stream Ext (active)',
  0x40: 'Stream Ext (DELETED)',
  0xC1: 'Filename Ext (active)',
  0x41: 'Filename Ext (DELETED)',
  0xA0: 'Volume GUID',
  0xA1: 'TexFAT Padding',
  0xA2: 'WinCE ACL Table',
  0x00: 'End of Directory',
}

let deletedCount = 0
let activeFileCount = 0
let entryIndex = 0

for (let i = 0; i < rootData.length; i += 32) {
  const entryType = rootData[i]
  if (entryType === 0x00) {
    console.log(`[${entryIndex}] 0x00 — End of Directory`)
    break
  }

  const typeName = entryTypeNames[entryType] || `Unknown (0x${entryType.toString(16)})`

  if (entryType === 0x85 || entryType === 0x05) {
    // File Directory Entry
    const secondaryCount = rootData[i + 1]
    const attrs = rootData.readUInt16LE(i + 4)
    const createTS = rootData.readUInt32LE(i + 8)
    const modifyTS = rootData.readUInt32LE(i + 12)
    const isDir = (attrs & 0x10) !== 0
    const isDeleted = entryType === 0x05

    if (isDeleted) deletedCount++
    if (entryType === 0x85 && !isDir) activeFileCount++

    console.log(`[${entryIndex}] 0x${entryType.toString(16).padStart(2, '0')} — ${typeName}  secondaryCount=${secondaryCount} attrs=0x${attrs.toString(16)} ${isDir ? 'DIR' : 'FILE'} createTS=0x${createTS.toString(16)} modifyTS=0x${modifyTS.toString(16)}`)
  } else if (entryType === 0xC0 || entryType === 0x40) {
    // Stream Extension
    const nameLen = rootData[i + 3]
    const firstCluster = rootData.readUInt32LE(i + 20)
    const dataLength = Number(rootData.readBigUInt64LE(i + 24))
    const validLength = Number(rootData.readBigUInt64LE(i + 8))
    const flags = rootData[i + 1]
    const noFatChain = (flags & 0x02) !== 0

    console.log(`[${entryIndex}] 0x${entryType.toString(16).padStart(2, '0')} — ${typeName}  nameLen=${nameLen} cluster=${firstCluster} size=${dataLength} (${(dataLength / 1024 / 1024).toFixed(1)}MB) validLen=${validLength} noFatChain=${noFatChain}`)
  } else if (entryType === 0xC1 || entryType === 0x41) {
    // Filename Extension
    const nameBuf = rootData.subarray(i + 2, i + 32)
    let name = ''
    for (let j = 0; j < 30; j += 2) {
      const code = nameBuf.readUInt16LE(j)
      if (code === 0x0000) break
      name += String.fromCharCode(code)
    }
    console.log(`[${entryIndex}] 0x${entryType.toString(16).padStart(2, '0')} — ${typeName}  "${name}"`)
  } else {
    console.log(`[${entryIndex}] 0x${entryType.toString(16).padStart(2, '0')} — ${typeName}`)
  }

  entryIndex++
}

console.log(`\n=== Summary ===`)
console.log(`  Total entries scanned: ${entryIndex}`)
console.log(`  Deleted file entries (0x05): ${deletedCount}`)
console.log(`  Active file entries (0x85): ${activeFileCount}`)

// ルートディレクトリにサブディレクトリがあれば、その中もチェック
console.log('\n=== Checking subdirectories ===')

for (let i = 0; i < rootData.length; i += 32) {
  const entryType = rootData[i]
  if (entryType === 0x00) break

  if (entryType === 0x85) {
    const attrs = rootData.readUInt16LE(i + 4)
    const isDir = (attrs & 0x10) !== 0
    if (!isDir) continue

    // 次のエントリがStreamなら読む
    if (i + 32 < rootData.length) {
      const nextType = rootData[i + 32]
      if (nextType === 0xC0) {
        const firstCluster = rootData.readUInt32LE(i + 32 + 20)
        // その次のエントリがFilenameなら名前を取得
        let dirName = '?'
        if (i + 64 < rootData.length && (rootData[i + 64] === 0xC1)) {
          const nb = rootData.subarray(i + 64 + 2, i + 64 + 32)
          dirName = ''
          for (let j = 0; j < 30; j += 2) {
            const code = nb.readUInt16LE(j)
            if (code === 0) break
            dirName += String.fromCharCode(code)
          }
        }

        console.log(`\n--- Subdirectory: ${dirName} (cluster ${firstCluster}) ---`)
        try {
          const subOffset = clusterToOffset(firstCluster, boot)
          const subData = readSectors(fd, subOffset, boot.bytesPerCluster * 2)
          let subDeleted = 0
          let subActive = 0
          let subIdx = 0
          for (let si = 0; si < subData.length; si += 32) {
            const st = subData[si]
            if (st === 0x00) break
            if (st === 0x05) subDeleted++
            if (st === 0x85) {
              const a = subData.readUInt16LE(si + 4)
              if (!(a & 0x10)) subActive++
            }
            if (st === 0xC1 || st === 0x41) {
              const nb2 = subData.subarray(si + 2, si + 32)
              let n = ''
              for (let j = 0; j < 30; j += 2) {
                const c = nb2.readUInt16LE(j)
                if (c === 0) break
                n += String.fromCharCode(c)
              }
              const isDeletedName = st === 0x41
              if (isDeletedName || st === 0xC1) {
                // Only print filenames for deleted or all files
                const prefix = isDeletedName ? '  [DEL]' : '  [ACT]'
                console.log(`${prefix} ${n}`)
              }
            }
            subIdx++
          }
          console.log(`  Entries: ${subIdx}, Deleted files: ${subDeleted}, Active files: ${subActive}`)
        } catch (err) {
          console.log(`  Error reading subdirectory: ${err}`)
        }
      }
    }
  }
}

closeDrive(fd)
console.log('\nDone.')
