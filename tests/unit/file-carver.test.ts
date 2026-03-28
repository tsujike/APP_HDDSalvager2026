import { describe, it, expect } from 'vitest'
import { isMp4Signature, findFtypBox } from '../../src/main/recovery/mp4-parser'

describe('file-carver (signature detection)', () => {
  describe('MP4 signature scanning', () => {
    it('should detect ftyp at sector boundary', () => {
      // Simulate sector-aligned scan
      const sectorSize = 512
      const buf = Buffer.alloc(sectorSize * 4, 0)

      // Place ftyp at sector 2 (offset 1024)
      const offset = sectorSize * 2
      buf.writeUInt32BE(32, offset)
      buf.write('ftyp', offset + 4, 'ascii')
      buf.write('avc1', offset + 8, 'ascii')

      expect(isMp4Signature(buf, offset)).toBe(true)
      expect(findFtypBox(buf)).toBe(offset)
    })

    it('should not detect ftyp in random data', () => {
      const buf = Buffer.alloc(4096)
      for (let i = 0; i < buf.length; i++) {
        buf[i] = Math.floor(Math.random() * 256)
      }
      // Clear any accidental ftyp matches
      for (let i = 0; i < buf.length - 8; i++) {
        if (buf[i + 4] === 0x66 && buf[i + 5] === 0x74 &&
            buf[i + 6] === 0x79 && buf[i + 7] === 0x70) {
          buf[i + 4] = 0
        }
      }
      expect(findFtypBox(buf)).toBe(-1)
    })

    it('should find multiple ftyp boxes (only first)', () => {
      const buf = Buffer.alloc(2048, 0)

      // First ftyp at offset 0
      buf.writeUInt32BE(24, 0)
      buf.write('ftyp', 4, 'ascii')

      // Second ftyp at offset 512
      buf.writeUInt32BE(24, 512)
      buf.write('ftyp', 516, 'ascii')

      expect(findFtypBox(buf)).toBe(0)
    })
  })

  describe('GoPro video structure', () => {
    it('should recognize typical GoPro MP4 structure (ftyp + moov + mdat)', () => {
      const buf = Buffer.alloc(256, 0)
      let offset = 0

      // ftyp box (size=20, brand=avc1)
      buf.writeUInt32BE(20, offset)
      buf.write('ftyp', offset + 4, 'ascii')
      buf.write('avc1', offset + 8, 'ascii')
      offset += 20

      // moov box (size=100)
      buf.writeUInt32BE(100, offset)
      buf.write('moov', offset + 4, 'ascii')
      offset += 100

      // mdat box (size=136)
      buf.writeUInt32BE(136, offset)
      buf.write('mdat', offset + 4, 'ascii')

      // All boxes should be detectable
      expect(isMp4Signature(buf, 0)).toBe(true)
      expect(buf.toString('ascii', 24, 28)).toBe('moov')
      expect(buf.toString('ascii', 124, 128)).toBe('mdat')
    })
  })
})
