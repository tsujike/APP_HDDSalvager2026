import type { RecoveredFile } from '../../main/recovery/types'
import { FileCard } from './FileCard'

interface Props {
  files: RecoveredFile[]
  selectedFiles: Set<string>
  onToggleFile: (fileId: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  outputDir: string
  onOutputDirChange: (dir: string) => void
  onStartRecovery: () => void
  isRecovering: boolean
  recoveryProgress: { current: number; total: number; fileName: string } | null
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export function FileList({
  files,
  selectedFiles,
  onToggleFile,
  onSelectAll,
  onDeselectAll,
  outputDir,
  onOutputDirChange,
  onStartRecovery,
  isRecovering,
  recoveryProgress
}: Props) {
  const selectedCount = selectedFiles.size
  const totalSize = files
    .filter(f => selectedFiles.has(f.id))
    .reduce((sum, f) => sum + f.fileSize, 0)

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium">
            検出されたファイル ({files.length}件)
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            {selectedCount}件選択中 / 合計 {formatBytes(totalSize)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onSelectAll}
            className="text-xs px-3 py-1.5 border border-gray-700 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          >
            全選択
          </button>
          <button
            onClick={onDeselectAll}
            className="text-xs px-3 py-1.5 border border-gray-700 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          >
            全解除
          </button>
        </div>
      </div>

      {/* ファイル一覧 */}
      {files.length === 0 ? (
        <div className="p-12 text-center border border-dashed border-gray-700 rounded-lg">
          <p className="text-gray-500">復元可能なファイルが見つかりませんでした</p>
          <p className="text-gray-600 text-xs mt-1">
            SDカードに新しいデータが上書きされている可能性があります
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
          {files.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              isSelected={selectedFiles.has(file.id)}
              onToggle={() => onToggleFile(file.id)}
            />
          ))}
        </div>
      )}

      {/* 出力先とアクション */}
      {files.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-gray-800">
          {/* 出力先入力 */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-400 whitespace-nowrap">保存先:</label>
            <input
              type="text"
              value={outputDir}
              onChange={(e) => onOutputDirChange(e.target.value)}
              placeholder="例: /output または D:\Recovery"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* 復元中のプログレス */}
          {isRecovering && recoveryProgress && (
            <div className="space-y-2">
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-300"
                  style={{ width: `${(recoveryProgress.current / recoveryProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-gray-400">
                {recoveryProgress.current} / {recoveryProgress.total}: {recoveryProgress.fileName}
              </p>
            </div>
          )}

          {/* 復元ボタン */}
          <button
            onClick={onStartRecovery}
            disabled={selectedCount === 0 || !outputDir || isRecovering}
            className={`w-full py-3 rounded-lg font-medium text-sm transition-colors ${
              selectedCount > 0 && outputDir && !isRecovering
                ? 'bg-green-600 hover:bg-green-500 text-white'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
            }`}
          >
            {isRecovering
              ? '復元中...'
              : `${selectedCount}件のファイルを復元`}
          </button>
        </div>
      )}
    </div>
  )
}
