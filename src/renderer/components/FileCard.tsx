import type { RecoveredFile } from '../../main/recovery/types'

interface Props {
  file: RecoveredFile
  isSelected: boolean
  onToggle: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function formatDate(timestamp: number): string {
  if (timestamp === 0) return '日時不明'
  const d = new Date(timestamp)
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getConfidenceLabel(confidence: number): { text: string; color: string } {
  if (confidence >= 0.8) return { text: '高', color: 'text-green-400' }
  if (confidence >= 0.5) return { text: '中', color: 'text-yellow-400' }
  return { text: '低', color: 'text-red-400' }
}

export function FileCard({ file, isSelected, onToggle }: Props) {
  const conf = getConfidenceLabel(file.confidence)

  return (
    <div
      onClick={onToggle}
      className={`flex items-center gap-4 p-3 rounded-lg border cursor-pointer transition-colors ${
        isSelected
          ? 'border-blue-500/50 bg-blue-950/20'
          : 'border-gray-800 hover:border-gray-700 hover:bg-gray-900/50'
      }`}
    >
      {/* チェックボックス */}
      <div
        className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          isSelected
            ? 'bg-blue-600 border-blue-600'
            : 'border-gray-600'
        }`}
      >
        {isSelected && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* サムネイル */}
      <div className="w-16 h-12 bg-gray-800 rounded flex-shrink-0 flex items-center justify-center">
        {file.thumbnail ? (
          <img
            src={`data:image/jpeg;base64,${file.thumbnail}`}
            alt=""
            className="w-full h-full object-cover rounded"
          />
        ) : (
          <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </div>

      {/* ファイル情報 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{file.fileName}</p>
        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
          <span>{formatDate(file.creationTime)}</span>
          <span>{formatBytes(file.fileSize)}</span>
          <span>{file.codec}</span>
        </div>
      </div>

      {/* メタ情報 */}
      <div className="flex-shrink-0 text-right">
        <span className={`text-xs ${
          file.recoveryMethod === 'fat-entry'
            ? 'text-cyan-400'
            : 'text-purple-400'
        }`}>
          {file.recoveryMethod === 'fat-entry' ? 'FAT' : 'Carve'}
        </span>
        <p className={`text-xs mt-1 ${conf.color}`}>
          信頼度: {conf.text}
        </p>
      </div>
    </div>
  )
}
