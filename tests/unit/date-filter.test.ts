import { describe, it, expect, vi, afterEach } from 'vitest'
import { getOneWeekAgoTimestamp, isWithinOneWeek, getFilterDate } from '../../src/main/utils/date-filter'

describe('date-filter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getOneWeekAgoTimestamp', () => {
    it('should return timestamp 7 days before now', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)

      const result = getOneWeekAgoTimestamp()
      const expected = now - 7 * 24 * 60 * 60 * 1000

      expect(result).toBe(expected)
    })
  })

  describe('isWithinOneWeek', () => {
    it('should return true for recent timestamp', () => {
      expect(isWithinOneWeek(Date.now() - 1000)).toBe(true)
    })

    it('should return true for exactly now', () => {
      expect(isWithinOneWeek(Date.now())).toBe(true)
    })

    it('should return false for 8 days ago', () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
      expect(isWithinOneWeek(eightDaysAgo)).toBe(false)
    })

    it('should return false for very old timestamp', () => {
      expect(isWithinOneWeek(0)).toBe(false)
    })
  })

  describe('getFilterDate', () => {
    it('should default to 7 days', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)

      expect(getFilterDate()).toBe(now - 7 * 24 * 60 * 60 * 1000)
    })

    it('should accept custom days', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)

      expect(getFilterDate(3)).toBe(now - 3 * 24 * 60 * 60 * 1000)
      expect(getFilterDate(14)).toBe(now - 14 * 24 * 60 * 60 * 1000)
    })
  })
})
