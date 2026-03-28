import type { ScanProgress as ScanProgressType } from '../../main/recovery/types'

interface Props {
  progress: ScanProgressType | null
  onAbort: () => void
}

const phaseLabels: Record<string, string> = {
  'fat-scan': 'FAT削除エントリをスキャン中...',
  'carving': 'ファイルカービング実行中...',
  'complete': 'スキャン完了'
}

export function ScanProgress({ progress, onAbort }: Props) {
  const percent = progress?.percent ?? 0
  const phase = progress?.phase ?? 'fat-scan'
  const filesFound = progress?.filesFound ?? 0

  return (
    <div className="max-w-lg mx-auto mt-16 space-y-6">
      <div className="text-center space-y-2">
        {/* アニメーション付きアイコン */}
        <div className="w-16 h-16 mx-auto mb-6 relative">
          <div className="absolute inset-0 rounded-full border-4 border-gray-800" />
          <div
            className="absolute inset-0 rounded-full border-4 border-blue-500 border-t-transparent animate-spin"
            style={{ animationDuration: '1.5s' }}
          />
        </div>

        <h2 className="text-lg font-medium">{phaseLabels[phase] || 'スキャン中...'}</h2>
        <p className="text-sm text-gray-400">
          {filesFound > 0
            ? `${filesFound} 件の動画ファイルを検出`
            : '削除されたファイルを検索しています...'}
        </p>
      </div>

      {/* プログレスバー */}
      <div className="space-y-2">
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500">
          <span>{percent}%</span>
          {progress && (
            <span>
              セクタ {progress.currentSector.toLocaleString()} / {progress.totalSectors.toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* 中断ボタン */}
      <div className="text-center">
        <button
          onClick={onAbort}
          className="px-6 py-2 text-sm border border-gray-700 rounded-lg text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          スキャンを中断
        </button>
      </div>
    </div>
  )
}
