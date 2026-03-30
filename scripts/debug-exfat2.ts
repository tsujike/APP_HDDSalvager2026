/**
 * DCIM/100GOPRO ディレクトリの削除エントリをダンプ
 * Usage: npx tsx scripts/debug-exfat2.ts J:
 */
import { openDrive, readSectors, closeDrive } from '../src/main/recovery/raw-disk.js'
import { parseBootSector, clusterToOffset, getNextCluster, isEndOfChain, loadFATCache } from '../src/main/recovery/fat-parser.js'

const driveLetter = process.argv[2] || 'J:'
const physicalDrive = `\\\\.\\${driveLetter.replace(':', '')}:`

const fd = openDrive(physicalDrive)
const boot = parseBootSector(fd)
console.log(`exFAT: ${boot.bytesPerCluster} bytes/cluster, root cluster=${boot.rootCluster}`)

// FATキャッシュをロード
loadFATCache(fd, boot)
console.log('FAT cache loaded')

// ルートディレクトリからDCIMの開始クラスタを探す
function findDirCluster(parentCluster: number, targetName: string): number | null {
  let cluster = parentCluster
  while (!isEndOfChain(cluster, boot.type)) {
    const data = readSectors(fd, clusterToOffset(cluster, boot), boot.bytesPerCluster)
    for (let i = 0; i < data.length; i += 32) {
      const t = data[i]
      if (t === 0x00) return null
      if (t === 0x85) {
        const attrs = data.readUInt16LE(i + 4)
        if (!(attrs & 0x10)) continue // not dir
        // Check stream ext
        if (i + 32 < data.length && data[i + 32] === 0xC0) {
          const dirCluster = data.readUInt32LE(i + 32 + 20)
          // Check filename
          if (i + 64 < data.length && data[i + 64] === 0xC1) {
            const nb = data.subarray(i + 64 + 2, i + 64 + 32)
            let name = ''
            for (let j = 0; j < 30; j += 2) {
              const c = nb.readUInt16LE(j)
              if (c === 0) break
              name += String.fromCharCode(c)
            }
            if (name === targetName) return dirCluster
          }
        }
      }
    }
    cluster = getNextCluster(fd, cluster, boot)
  }
  return null
}

const dcimCluster = findDirCluster(boot.rootCluster, 'DCIM')
if (!dcimCluster) { console.error('DCIM not found'); process.exit(1) }
console.log(`DCIM cluster: ${dcimCluster}`)

const goProCluster = findDirCluster(dcimCluster, '100GOPRO')
if (!goProCluster) { console.error('100GOPRO not found'); process.exit(1) }
console.log(`100GOPRO cluster: ${goProCluster}`)

// 100GOPROディレクトリの全クラスタを走査
let cluster = goProCluster
let totalEntries = 0
let deletedFiles = 0
let activeFiles = 0
let deletedMP4s: { name: string; cluster: number; size: number; noFatChain: boolean }[] = []
let activeMP4s: { name: string; cluster: number; size: number; noFatChain: boolean }[] = []
let clusterCount = 0

while (!isEndOfChain(cluster, boot.type) && cluster >= 2) {
  clusterCount++
  if (clusterCount > 1000) { console.log('Too many clusters, stopping'); break }

  const data = readSectors(fd, clusterToOffset(cluster, boot), boot.bytesPerCluster)

  let pendingFile: { isDeleted: boolean; attrs: number } | null = null
  let pendingStream: { cluster: number; size: number; noFatChain: boolean } | null = null
  let nameParts: string[] = []

  for (let i = 0; i < data.length; i += 32) {
    const t = data[i]
    if (t === 0x00) { /* end */ break }

    if (t === 0x85 || t === 0x05) {
      // Flush previous
      if (pendingFile && pendingStream) {
        const fullName = nameParts.join('')
        const ext = fullName.split('.').pop()?.toUpperCase() || ''
        if (pendingFile.isDeleted) {
          deletedFiles++
          if (ext === 'MP4' || ext === 'LRV' || ext === 'THM') {
            deletedMP4s.push({ name: fullName, cluster: pendingStream.cluster, size: pendingStream.size, noFatChain: pendingStream.noFatChain })
          }
        } else {
          activeFiles++
          if (ext === 'MP4' || ext === 'LRV' || ext === 'THM') {
            activeMP4s.push({ name: fullName, cluster: pendingStream.cluster, size: pendingStream.size, noFatChain: pendingStream.noFatChain })
          }
        }
      }
      pendingFile = { isDeleted: t === 0x05, attrs: data.readUInt16LE(i + 4) }
      pendingStream = null
      nameParts = []
      totalEntries++
    } else if (t === 0xC0 || t === 0x40) {
      if (pendingFile) {
        const flags = data[i + 1]
        pendingStream = {
          cluster: data.readUInt32LE(i + 20),
          size: Number(data.readBigUInt64LE(i + 24)),
          noFatChain: (flags & 0x02) !== 0
        }
      }
    } else if (t === 0xC1 || t === 0x41) {
      const nb = data.subarray(i + 2, i + 32)
      let part = ''
      for (let j = 0; j < 30; j += 2) {
        const c = nb.readUInt16LE(j)
        if (c === 0) break
        part += String.fromCharCode(c)
      }
      nameParts.push(part)
    }
  }

  // Flush last entry
  if (pendingFile && pendingStream) {
    const fullName = nameParts.join('')
    const ext = fullName.split('.').pop()?.toUpperCase() || ''
    if (pendingFile.isDeleted) {
      deletedFiles++
      if (ext === 'MP4' || ext === 'LRV' || ext === 'THM') {
        deletedMP4s.push({ name: fullName, cluster: pendingStream.cluster, size: pendingStream.size, noFatChain: pendingStream.noFatChain })
      }
    } else {
      activeFiles++
      if (ext === 'MP4' || ext === 'LRV' || ext === 'THM') {
        activeMP4s.push({ name: fullName, cluster: pendingStream.cluster, size: pendingStream.size, noFatChain: pendingStream.noFatChain })
      }
    }
  }

  cluster = getNextCluster(fd, cluster, boot)
}

console.log(`\n=== 100GOPRO Directory ===`)
console.log(`  Clusters scanned: ${clusterCount}`)
console.log(`  Total file entries: ${totalEntries}`)
console.log(`  Active files: ${activeFiles}`)
console.log(`  Deleted files: ${deletedFiles}`)

if (activeMP4s.length > 0) {
  console.log(`\n--- Active MP4/LRV/THM files (${activeMP4s.length}) ---`)
  for (const f of activeMP4s.slice(0, 20)) {
    console.log(`  ${f.name}  cluster=${f.cluster}  size=${f.size} (${(f.size/1024/1024).toFixed(1)}MB)  noFatChain=${f.noFatChain}`)
  }
  if (activeMP4s.length > 20) console.log(`  ... and ${activeMP4s.length - 20} more`)
}

if (deletedMP4s.length > 0) {
  console.log(`\n--- Deleted MP4/LRV/THM files (${deletedMP4s.length}) ---`)
  for (const f of deletedMP4s.slice(0, 50)) {
    console.log(`  ${f.name}  cluster=${f.cluster}  size=${f.size} (${(f.size/1024/1024).toFixed(1)}MB)  noFatChain=${f.noFatChain}`)
  }
  if (deletedMP4s.length > 50) console.log(`  ... and ${deletedMP4s.length - 50} more`)
} else {
  console.log('\n--- No deleted MP4/LRV/THM files found ---')
}

closeDrive(fd)
console.log('\nDone.')
