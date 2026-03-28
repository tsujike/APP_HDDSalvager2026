interface Props {
  result: {
    succeeded: string[]
    failed: { fileName: string; error: string }[]
  } | null
  onReset: () => void
}

export function RecoveryComplete({ result, onReset }: Props) {
  if (!result) return null

  const { succeeded, failed } = result
  const totalCount = succeeded.length + failed.length

  return (
    <div className="max-w-lg mx-auto mt-8 space-y-6">
      {/* 結果サマリー */}
      <div className="text-center space-y-3">
        <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center ${
          failed.length === 0 ? 'bg-green-900/50' : 'bg-yellow-900/50'
        }`}>
          {failed.length === 0 ? (
            <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-8 h-8 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          )}
        </div>

        <h2 className="text-lg font-medium">
          {failed.length === 0
            ? '復元が完了しました'
            : '復元が完了しました（一部エラーあり）'}
        </h2>
        <p className="text-sm text-gray-400">
          {totalCount}件中 {succeeded.length}件のファイルを正常に復元しました
        </p>
      </div>

      {/* 成功ファイル */}
      {succeeded.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-green-400">
            復元成功 ({succeeded.length}件)
          </h3>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {succeeded.map((filePath, i) => (
              <p key={i} className="text-xs text-gray-400 font-mono truncate px-3 py-1.5 bg-gray-900 rounded">
                {filePath}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* 失敗ファイル */}
      {failed.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-red-400">
            復元失敗 ({failed.length}件)
          </h3>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {failed.map((f, i) => (
              <div key={i} className="px-3 py-2 bg-red-950/30 border border-red-900/50 rounded text-xs">
                <p className="text-gray-300 truncate">{f.fileName}</p>
                <p className="text-red-400 mt-0.5">{f.error}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* アクションボタン */}
      <div className="flex gap-3">
        <button
          onClick={onReset}
          className="flex-1 py-3 rounded-lg font-medium text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          最初からやり直す
        </button>
      </div>
    </div>
  )
}
