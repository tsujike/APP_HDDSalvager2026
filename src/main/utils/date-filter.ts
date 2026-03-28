/**
 * 日時フィルタリングユーティリティ
 */

/** 1週間のミリ秒 */
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 「直近1週間以内」の基準日時を返す。
 * 現在時刻から7日前のUnix timestamp (ms)。
 */
export function getOneWeekAgoTimestamp(): number {
  return Date.now() - ONE_WEEK_MS
}

/**
 * 指定日時が直近1週間以内かどうかを判定する。
 */
export function isWithinOneWeek(timestamp: number): boolean {
  return timestamp >= getOneWeekAgoTimestamp()
}

/**
 * 日時範囲でフィルタする基準日時を計算する。
 * @param daysBack 何日前までを対象とするか (デフォルト: 7)
 */
export function getFilterDate(daysBack: number = 7): number {
  return Date.now() - daysBack * 24 * 60 * 60 * 1000
}
