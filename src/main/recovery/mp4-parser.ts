/**
 * MP4 ヘッダパーサー
 *
 * ISO Base Media File Format (ISO 14496-12) の最小限パース。
 * ftyp box の検出と moov > mvhd の creation_time 取得に特化。
 */

/** MP4 box シグネチャ */
const BOX_FTYP = Buffer.from('ftyp')
const BOX_MOOV = Buffer.from('moov')
const BOX_MVHD = Buffer.from('mvhd')
const BOX_MDAT = Buffer.from('mdat')

/** GoPro で使われる ftyp brand 一覧 */
const GOPRO_BRANDS = new Set([
  'avc1', // H.264
  'mp41', // H.265 (一部モデル)
  'mp42', // H.265
  'isom', // 汎用
])

/** 1904-01-01 から 1970-01-01 までの秒数 */
const EPOCH_OFFSET = 2082844800

/**
 * MP4 の ftyp box シグネチャかどうかを判定する。
 * ftyp box のフォーマット: [4bytes size][4bytes 'ftyp'][4bytes major_brand]...
 */
export function isMp4Signature(buf: Buffer, offset: number = 0): boolean {
  if (offset + 8 > buf.length) return false
  return buf.subarray(offset + 4, offset + 8).equals(BOX_FTYP)
}

/**
 * バッファ内で ftyp box を検索し、最初に見つかったオフセットを返す。
 */
export function findFtypBox(buf: Buffer): number {
  for (let i = 0; i <= buf.length - 8; i++) {
    if (buf[i + 4] === 0x66 && // 'f'
        buf[i + 5] === 0x74 && // 't'
        buf[i + 6] === 0x79 && // 'y'
        buf[i + 7] === 0x70) { // 'p'
      // サイズフィールドの妥当性チェック
      const size = buf.readUInt32BE(i)
      if (size >= 8 && size <= 1024) {
        return i
      }
    }
  }
  return -1
}

/**
 * ftyp box から major brand を読み取り、コーデック種別を推定する。
 */
export function detectCodec(buf: Buffer, ftypOffset: number = 0): 'H.264' | 'H.265' | 'unknown' {
  if (ftypOffset + 12 > buf.length) return 'unknown'

  const brand = buf.toString('ascii', ftypOffset + 8, ftypOffset + 12)

  if (brand === 'avc1') return 'H.264'
  if (brand === 'mp41' || brand === 'mp42') return 'H.265'
  if (brand === 'isom') {
    // compatible brands をチェック
    const boxSize = buf.readUInt32BE(ftypOffset)
    for (let i = ftypOffset + 16; i + 4 <= ftypOffset + boxSize && i + 4 <= buf.length; i += 4) {
      const compat = buf.toString('ascii', i, i + 4)
      if (compat === 'avc1') return 'H.264'
      if (compat === 'hvc1' || compat === 'hev1') return 'H.265'
    }
  }

  return 'unknown'
}

/**
 * MP4 データから creation_time を取得する。
 * moov > mvhd box を探して creation_time (UTC) を読み取る。
 *
 * @param buf MP4ファイルの先頭部分（moov boxを含む範囲）
 * @returns Unix timestamp (ms) or null
 */
export function getCreationTime(buf: Buffer): number | null {
  const moovOffset = findBox(buf, BOX_MOOV, 0)
  if (moovOffset === -1) return null

  const moovSize = buf.readUInt32BE(moovOffset)
  const moovEnd = Math.min(moovOffset + moovSize, buf.length)

  // moov box の中から mvhd box を探す
  const mvhdOffset = findBox(buf, BOX_MVHD, moovOffset + 8, moovEnd)
  if (mvhdOffset === -1) return null

  // mvhd の構造:
  // [4 bytes size][4 bytes 'mvhd'][1 byte version][3 bytes flags]
  // version 0: [4 bytes creation_time][4 bytes modification_time]...
  // version 1: [8 bytes creation_time][8 bytes modification_time]...
  const version = buf.readUInt8(mvhdOffset + 8)
  let creationTime: number

  if (version === 0) {
    if (mvhdOffset + 16 > buf.length) return null
    creationTime = buf.readUInt32BE(mvhdOffset + 12)
  } else if (version === 1) {
    if (mvhdOffset + 20 > buf.length) return null
    // 64bit値だが上位32bitは通常0
    creationTime = Number(buf.readBigUInt64BE(mvhdOffset + 12))
  } else {
    return null
  }

  if (creationTime === 0) return null

  // 1904 epoch → Unix epoch に変換 (秒 → ミリ秒)
  const unixSeconds = creationTime - EPOCH_OFFSET
  if (unixSeconds < 0) return null

  return unixSeconds * 1000
}

/**
 * MP4ファイルの推定サイズを取得する。
 * トップレベルboxのサイズを合算する。
 */
export function estimateFileSize(buf: Buffer, startOffset: number = 0): number {
  let offset = startOffset
  let totalSize = 0

  while (offset + 8 <= buf.length) {
    let boxSize = buf.readUInt32BE(offset)
    const boxType = buf.toString('ascii', offset + 4, offset + 8)

    if (boxSize === 0) {
      // box size 0 = ファイル末尾まで
      break
    }

    if (boxSize === 1 && offset + 16 <= buf.length) {
      // 拡張サイズ (64bit)
      boxSize = Number(buf.readBigUInt64BE(offset + 8))
    }

    if (boxSize < 8) break

    totalSize += boxSize
    offset += boxSize

    // mdat の後は通常ファイル末尾
    if (boxType === 'mdat') break
  }

  return totalSize
}

/**
 * バッファ内で指定タイプのboxを検索する。
 */
function findBox(
  buf: Buffer,
  boxType: Buffer,
  startOffset: number = 0,
  endOffset?: number
): number {
  const end = endOffset ?? buf.length
  let offset = startOffset

  while (offset + 8 <= end) {
    let boxSize = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8)

    if (boxSize === 1 && offset + 16 <= end) {
      boxSize = Number(buf.readBigUInt64BE(offset + 8))
    }

    if (boxSize < 8) break

    if (type.equals(boxType)) {
      return offset
    }

    offset += boxSize
  }

  return -1
}

/**
 * GoPro の ftyp brand かどうかを判定する。
 */
export function isGoProBrand(buf: Buffer, ftypOffset: number = 0): boolean {
  if (ftypOffset + 12 > buf.length) return false
  const brand = buf.toString('ascii', ftypOffset + 8, ftypOffset + 12)
  return GOPRO_BRANDS.has(brand)
}
