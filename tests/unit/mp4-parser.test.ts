import { describe, it, expect } from 'vitest'
import {
  isMp4Signature,
  findFtypBox,
  detectCodec,
  getCreationTime,
  estimateFileSize
} from '../../src/main/recovery/mp4-parser'

describe('mp4-parser', () => {
  describe('isMp4Signature', () => {
    it('should detect ftyp box signature', () => {
      // [size=0x00000020][type='ftyp']
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(0x00000020, 0)
      buf.write('ftyp', 4, 'ascii')
      expect(isMp4Signature(buf, 0)).toBe(true)
    })

    it('should return false for non-ftyp data', () => {
      const buf = Buffer.alloc(32)
      buf.write('notampeg', 0, 'ascii')
      expect(isMp4Signature(buf, 0)).toBe(false)
    })

    it('should return false for buffer too small', () => {
      const buf = Buffer.alloc(4)
      expect(isMp4Signature(buf, 0)).toBe(false)
    })
  })

  describe('findFtypBox', () => {
    it('should find ftyp box at beginning', () => {
      const buf = Buffer.alloc(64)
      buf.writeUInt32BE(32, 0) // size = 32
      buf.write('ftyp', 4, 'ascii')
      expect(findFtypBox(buf)).toBe(0)
    })

    it('should find ftyp box at offset', () => {
      const buf = Buffer.alloc(128)
      buf.writeUInt32BE(32, 40) // size = 32
      buf.write('ftyp', 44, 'ascii')
      expect(findFtypBox(buf)).toBe(40)
    })

    it('should return -1 when not found', () => {
      const buf = Buffer.alloc(64, 0)
      expect(findFtypBox(buf)).toBe(-1)
    })

    it('should reject ftyp with invalid size', () => {
      const buf = Buffer.alloc(64)
      buf.writeUInt32BE(2048, 0) // size too large for ftyp
      buf.write('ftyp', 4, 'ascii')
      expect(findFtypBox(buf)).toBe(-1)
    })
  })

  describe('detectCodec', () => {
    it('should detect H.264 from avc1 brand', () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(32, 0)
      buf.write('ftyp', 4, 'ascii')
      buf.write('avc1', 8, 'ascii')
      expect(detectCodec(buf, 0)).toBe('H.264')
    })

    it('should detect H.265 from mp41 brand', () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(32, 0)
      buf.write('ftyp', 4, 'ascii')
      buf.write('mp41', 8, 'ascii')
      expect(detectCodec(buf, 0)).toBe('H.265')
    })

    it('should detect H.265 from isom with hvc1 compat brand', () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(24, 0) // size = 24 (ftyp + brand + minor + 1 compat)
      buf.write('ftyp', 4, 'ascii')
      buf.write('isom', 8, 'ascii')
      buf.writeUInt32BE(0, 12) // minor version
      buf.write('hvc1', 16, 'ascii')
      expect(detectCodec(buf, 0)).toBe('H.265')
    })

    it('should return unknown for unrecognized brand', () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(32, 0)
      buf.write('ftyp', 4, 'ascii')
      buf.write('XXXX', 8, 'ascii')
      expect(detectCodec(buf, 0)).toBe('unknown')
    })
  })

  describe('getCreationTime', () => {
    it('should parse creation_time from mvhd v0', () => {
      // Build minimal: ftyp + moov(mvhd)
      const ftypSize = 16
      const mvhdSize = 32
      const moovSize = 8 + mvhdSize

      const buf = Buffer.alloc(ftypSize + moovSize)
      let offset = 0

      // ftyp box
      buf.writeUInt32BE(ftypSize, offset)
      buf.write('ftyp', offset + 4, 'ascii')
      offset += ftypSize

      // moov box
      buf.writeUInt32BE(moovSize, offset)
      buf.write('moov', offset + 4, 'ascii')
      offset += 8

      // mvhd box (version 0)
      buf.writeUInt32BE(mvhdSize, offset)
      buf.write('mvhd', offset + 4, 'ascii')
      buf.writeUInt8(0, offset + 8) // version
      // creation_time: 2082844800 + 1700000000 = 3782844800
      // (1904 epoch + Unix timestamp for ~2023)
      const mp4Epoch = 2082844800
      const unixTime = 1700000000 // 2023-11-14
      buf.writeUInt32BE(mp4Epoch + unixTime, offset + 12)
      offset += mvhdSize

      const result = getCreationTime(buf)
      expect(result).toBe(unixTime * 1000)
    })

    it('should return null when no moov box', () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(16, 0)
      buf.write('ftyp', 4, 'ascii')
      buf.writeUInt32BE(16, 16)
      buf.write('mdat', 20, 'ascii')
      expect(getCreationTime(buf)).toBeNull()
    })

    it('should return null when creation_time is 0', () => {
      const buf = Buffer.alloc(64)
      let offset = 0

      buf.writeUInt32BE(16, offset)
      buf.write('ftyp', offset + 4, 'ascii')
      offset += 16

      buf.writeUInt32BE(48, offset)
      buf.write('moov', offset + 4, 'ascii')
      offset += 8

      buf.writeUInt32BE(32, offset)
      buf.write('mvhd', offset + 4, 'ascii')
      buf.writeUInt8(0, offset + 8)
      buf.writeUInt32BE(0, offset + 12) // creation_time = 0

      expect(getCreationTime(buf)).toBeNull()
    })
  })

  describe('estimateFileSize', () => {
    it('should sum up box sizes', () => {
      const buf = Buffer.alloc(48)

      // Box 1: size=16
      buf.writeUInt32BE(16, 0)
      buf.write('ftyp', 4, 'ascii')

      // Box 2: size=32, type=mdat (should stop after mdat)
      buf.writeUInt32BE(32, 16)
      buf.write('mdat', 20, 'ascii')

      expect(estimateFileSize(buf)).toBe(48) // 16 + 32
    })

    it('should handle empty buffer', () => {
      const buf = Buffer.alloc(0)
      expect(estimateFileSize(buf)).toBe(0)
    })

    it('should stop on invalid box size', () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(16, 0)
      buf.write('ftyp', 4, 'ascii')
      buf.writeUInt32BE(4, 16) // invalid size < 8
      expect(estimateFileSize(buf)).toBe(16)
    })
  })
})
