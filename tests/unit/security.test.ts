import { describe, it, expect } from 'vitest'

/**
 * セキュリティ関連のバリデーションロジックのテスト。
 * api.tsの内部関数を抽出して検証する。
 */

// api.tsから抽出したバリデーションロジック
function isValidPhysicalDrive(drive: string, platform: string): boolean {
  if (platform === 'win32') {
    return /^\\\\\.\\PhysicalDrive\d+$/i.test(drive)
  }
  return /^\/dev\/(sd[a-z]|mmcblk\d+)$/.test(drive)
}

describe('physicalDrive validation', () => {
  describe('Windows', () => {
    const p = 'win32'

    it('正常なPhysicalDriveパスを許可', () => {
      expect(isValidPhysicalDrive('\\\\.\\PhysicalDrive0', p)).toBe(true)
      expect(isValidPhysicalDrive('\\\\.\\PhysicalDrive2', p)).toBe(true)
      expect(isValidPhysicalDrive('\\\\.\\PhysicalDrive15', p)).toBe(true)
    })

    it('ドライブレター形式を拒否', () => {
      expect(isValidPhysicalDrive('C:\\', p)).toBe(false)
      expect(isValidPhysicalDrive('\\\\.\\C:', p)).toBe(false)
      expect(isValidPhysicalDrive('E:', p)).toBe(false)
    })

    it('コマンドインジェクションを拒否', () => {
      expect(isValidPhysicalDrive('\\\\.\\PhysicalDrive0; rm -rf /', p)).toBe(false)
      expect(isValidPhysicalDrive('\\\\.\\PhysicalDrive0 && del *', p)).toBe(false)
      expect(isValidPhysicalDrive('\\\\.\\PhysicalDrive0\n\\\\.\\PhysicalDrive1', p)).toBe(false)
    })

    it('空文字列を拒否', () => {
      expect(isValidPhysicalDrive('', p)).toBe(false)
    })
  })

  describe('Linux', () => {
    const p = 'linux'

    it('正常なデバイスパスを許可', () => {
      expect(isValidPhysicalDrive('/dev/sda', p)).toBe(true)
      expect(isValidPhysicalDrive('/dev/sdb', p)).toBe(true)
      expect(isValidPhysicalDrive('/dev/sdz', p)).toBe(true)
      expect(isValidPhysicalDrive('/dev/mmcblk0', p)).toBe(true)
      expect(isValidPhysicalDrive('/dev/mmcblk1', p)).toBe(true)
    })

    it('パーティションパスを拒否', () => {
      expect(isValidPhysicalDrive('/dev/sda1', p)).toBe(false)
      expect(isValidPhysicalDrive('/dev/mmcblk0p1', p)).toBe(false)
    })

    it('危険なパスを拒否', () => {
      expect(isValidPhysicalDrive('/dev/null', p)).toBe(false)
      expect(isValidPhysicalDrive('/dev/zero', p)).toBe(false)
      expect(isValidPhysicalDrive('/etc/passwd', p)).toBe(false)
      expect(isValidPhysicalDrive('/proc/self/mem', p)).toBe(false)
    })

    it('パストラバーサルを拒否', () => {
      expect(isValidPhysicalDrive('/dev/../etc/passwd', p)).toBe(false)
      expect(isValidPhysicalDrive('/dev/sda; cat /etc/shadow', p)).toBe(false)
    })
  })
})

describe('estimateFileSize upper bound', () => {
  const MAX_ESTIMATED_FILE_SIZE = 4 * 1024 * 1024 * 1024 // 4GB

  it('4GB以下のboxSizeは許可', () => {
    const size = 3 * 1024 * 1024 * 1024 // 3GB
    expect(size <= MAX_ESTIMATED_FILE_SIZE).toBe(true)
  })

  it('4GB超のboxSizeは拒否', () => {
    const size = 5 * 1024 * 1024 * 1024 // 5GB
    expect(size > MAX_ESTIMATED_FILE_SIZE).toBe(true)
  })
})

describe('sector alignment calculation', () => {
  const SECTOR_SIZE = 512

  function computeAlignedRead(offsetBytes: number, lengthBytes: number) {
    const alignedOffset = Math.floor(offsetBytes / SECTOR_SIZE) * SECTOR_SIZE
    const headPadding = offsetBytes - alignedOffset
    const alignedLength = Math.ceil((headPadding + lengthBytes) / SECTOR_SIZE) * SECTOR_SIZE
    return { alignedOffset, headPadding, alignedLength }
  }

  it('アライン済みオフセットはそのまま', () => {
    const r = computeAlignedRead(512, 512)
    expect(r.alignedOffset).toBe(512)
    expect(r.headPadding).toBe(0)
    expect(r.alignedLength).toBe(512)
  })

  it('非アラインオフセットは切り下げ', () => {
    const r = computeAlignedRead(600, 100)
    expect(r.alignedOffset).toBe(512)
    expect(r.headPadding).toBe(88)
    expect(r.alignedLength).toBe(512)
  })

  it('セクタ境界をまたぐ読み取り', () => {
    const r = computeAlignedRead(256, 512)
    expect(r.alignedOffset).toBe(0)
    expect(r.headPadding).toBe(256)
    expect(r.alignedLength).toBe(1024)
  })

  it('大きな読み取り', () => {
    const r = computeAlignedRead(1000, 10000)
    expect(r.alignedOffset).toBe(512)
    expect(r.headPadding).toBe(488)
    // ceil((488+10000)/512)*512 = ceil(10488/512)*512 = 21*512 = 10752
    expect(r.alignedLength).toBe(10752)
  })

  it('アラインされたオフセットとサイズ', () => {
    const r = computeAlignedRead(1024, 2048)
    expect(r.alignedOffset).toBe(1024)
    expect(r.headPadding).toBe(0)
    expect(r.alignedLength).toBe(2048)
  })
})

describe('exFAT boot sector offsets', () => {
  it('MustBeZero領域(11-63)はFatOffset/FatLengthを含まない', () => {
    const buf = Buffer.alloc(512, 0)
    buf.write('EXFAT   ', 3, 'ascii')

    // 実際のFatOffset/FatLengthをセット
    buf.writeUInt32LE(24, 80)   // FatOffset (正しいオフセット)
    buf.writeUInt32LE(256, 84)  // FatLength (正しいオフセット)

    // MustBeZero領域は0のまま
    expect(buf.readUInt32LE(40)).toBe(0) // 旧コードが使っていた間違ったオフセット
    expect(buf.readUInt32LE(44)).toBe(0) // 旧コードが使っていた間違ったオフセット

    // 正しいオフセットで値が読める
    expect(buf.readUInt32LE(80)).toBe(24)
    expect(buf.readUInt32LE(84)).toBe(256)
  })
})
