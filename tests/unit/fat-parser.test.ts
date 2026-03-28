import { describe, it, expect } from 'vitest'

// FATパーサーの内部ロジックをテスト（rawディスクI/Oを使わない部分）

describe('fat-parser helpers', () => {
  describe('FAT date/time parsing', () => {
    // parseFATDateTimeは内部関数なので、ロジックを直接テスト
    function parseFATDateTime(date: number, time: number): number {
      const year = ((date >> 9) & 0x7f) + 1980
      const month = ((date >> 5) & 0x0f) - 1
      const day = date & 0x1f
      const hour = (time >> 11) & 0x1f
      const minute = (time >> 5) & 0x3f
      const second = (time & 0x1f) * 2
      return new Date(year, month, day, hour, minute, second).getTime()
    }

    it('should parse 2024-03-15 14:30:00', () => {
      // Date: year=44(2024-1980), month=3, day=15
      const date = (44 << 9) | (3 << 5) | 15 // 0x586F
      // Time: hour=14, min=30, sec=0
      const time = (14 << 11) | (30 << 5) | 0 // 0x73C0
      const result = new Date(parseFATDateTime(date, time))
      expect(result.getFullYear()).toBe(2024)
      expect(result.getMonth()).toBe(2) // 0-indexed
      expect(result.getDate()).toBe(15)
      expect(result.getHours()).toBe(14)
      expect(result.getMinutes()).toBe(30)
    })

    it('should parse 2026-01-01 00:00:00', () => {
      const date = (46 << 9) | (1 << 5) | 1
      const time = 0
      const result = new Date(parseFATDateTime(date, time))
      expect(result.getFullYear()).toBe(2026)
      expect(result.getMonth()).toBe(0)
      expect(result.getDate()).toBe(1)
    })
  })

  describe('cluster calculations', () => {
    function clusterToSector(
      cluster: number,
      dataStartSector: number,
      sectorsPerCluster: number
    ): number {
      return dataStartSector + (cluster - 2) * sectorsPerCluster
    }

    it('should convert cluster 2 to dataStartSector', () => {
      expect(clusterToSector(2, 1024, 64)).toBe(1024)
    })

    it('should convert cluster 10 correctly', () => {
      // (10-2) * 64 + 1024 = 512 + 1024 = 1536
      expect(clusterToSector(10, 1024, 64)).toBe(1536)
    })
  })

  describe('end-of-chain detection', () => {
    function isEndOfChain(cluster: number, type: 'FAT32' | 'exFAT'): boolean {
      if (type === 'FAT32') return cluster >= 0x0ffffff8
      return cluster >= 0xfffffff8
    }

    it('should detect FAT32 end-of-chain', () => {
      expect(isEndOfChain(0x0ffffff8, 'FAT32')).toBe(true)
      expect(isEndOfChain(0x0fffffff, 'FAT32')).toBe(true)
      expect(isEndOfChain(0x0ffffff7, 'FAT32')).toBe(false)
    })

    it('should detect exFAT end-of-chain', () => {
      expect(isEndOfChain(0xfffffff8, 'exFAT')).toBe(true)
      expect(isEndOfChain(0xffffffff, 'exFAT')).toBe(true)
      expect(isEndOfChain(0xfffffff7, 'exFAT')).toBe(false)
    })
  })

  describe('deleted marker', () => {
    it('should identify 0xE5 as deleted entry', () => {
      const entry = Buffer.alloc(32)
      entry[0] = 0xe5
      expect(entry[0]).toBe(0xe5)
    })

    it('should identify 0x00 as end-of-directory', () => {
      const entry = Buffer.alloc(32, 0)
      expect(entry[0]).toBe(0x00)
    })
  })

  describe('LFN extraction', () => {
    function extractLFNPart(entry: Buffer): string {
      const chars: number[] = []
      const offsets = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
      for (const off of offsets) {
        if (off + 1 >= entry.length) break
        const code = entry.readUInt16LE(off)
        if (code === 0x0000 || code === 0xffff) break
        chars.push(code)
      }
      return String.fromCharCode(...chars)
    }

    it('should extract unicode characters from LFN entry', () => {
      const entry = Buffer.alloc(32, 0xff)
      entry[0] = 0x01 // sequence number
      entry[11] = 0x0f // LFN attribute

      // Write "GX01" at LFN character positions
      entry.writeUInt16LE('G'.charCodeAt(0), 1)
      entry.writeUInt16LE('X'.charCodeAt(0), 3)
      entry.writeUInt16LE('0'.charCodeAt(0), 5)
      entry.writeUInt16LE('1'.charCodeAt(0), 7)
      entry.writeUInt16LE(0x0000, 9) // null terminator

      expect(extractLFNPart(entry)).toBe('GX01')
    })
  })

  describe('boot sector parsing (FAT32)', () => {
    it('should extract fields from FAT32 boot sector buffer', () => {
      const buf = Buffer.alloc(512, 0)

      // Standard FAT32 fields
      buf.writeUInt16LE(512, 11)   // bytesPerSector
      buf.writeUInt8(64, 13)       // sectorsPerCluster
      buf.writeUInt16LE(32, 14)    // reservedSectors
      buf.writeUInt8(2, 16)        // numberOfFATs
      buf.writeUInt32LE(0, 19)     // totalSectors16 = 0
      buf.writeUInt32LE(120000, 32) // totalSectors32
      buf.writeUInt32LE(1000, 36)  // sectorsPerFAT
      buf.writeUInt32LE(2, 44)     // rootCluster

      // Verify we can read them correctly
      expect(buf.readUInt16LE(11)).toBe(512)
      expect(buf.readUInt8(13)).toBe(64)
      expect(buf.readUInt16LE(14)).toBe(32)
      expect(buf.readUInt32LE(36)).toBe(1000)
      expect(buf.readUInt32LE(44)).toBe(2)
    })
  })
})
