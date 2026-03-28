import type { DriveInfo } from '../../main/recovery/types'

interface Props {
  drives: DriveInfo[]
  selectedDrive: DriveInfo | null
  onSelectDrive: (drive: DriveInfo) => void
  onRefresh: () => void
  daysBack: number
  onDaysBackChange: (days: number) => void
  enableCarving: boolean
  onEnableCarvingChange: (enabled: boolean) => void
  onStartScan: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export function DriveSelector({
  drives,
  selectedDrive,
  onSelectDrive,
  onRefresh,
  daysBack,
  onDaysBackChange,
  enableCarving,
  onEnableCarvingChange,
  onStartScan
}: Props) {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* 警告 */}
      <div className="p-4 bg-amber-950/50 border border-amber-800/50 rounded-lg">
        <p className="text-amber-300 text-sm font-medium mb-1">
          復元前の注意事項
        </p>
        <p className="text-amber-200/70 text-xs">
          SDカードに新しいデータを書き込むと復元できなくなります。復元が完了するまでSDカードへの書き込みは避けてください。
        </p>
      </div>

      {/* ドライブ選択 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">SDカードを選択</h2>
          <button
            onClick={onRefresh}
            className="text-xs text-blue-400 hover:text-blue-300 px-3 py-1.5 border border-gray-700 rounded-md hover:bg-gray-800 transition-colors"
          >
            再検出
          </button>
        </div>

        {drives.length === 0 ? (
          <div className="p-8 text-center border border-dashed border-gray-700 rounded-lg">
            <p className="text-gray-500 text-sm">
              リムーバブルドライブが見つかりません
            </p>
            <p className="text-gray-600 text-xs mt-1">
              SDカードを挿入してから「再検出」をクリックしてください
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {drives.map((drive) => (
              <button
                key={drive.letter}
                onClick={() => onSelectDrive(drive)}
                className={`w-full text-left p-4 rounded-lg border transition-colors ${
                  selectedDrive?.letter === drive.letter
                    ? 'border-blue-500 bg-blue-950/30'
                    : 'border-gray-700 hover:border-gray-600 hover:bg-gray-900'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{drive.letter}</span>
                      {drive.label && (
                        <span className="text-gray-400 text-sm">{drive.label}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{drive.deviceName}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-sm text-gray-300">{formatBytes(drive.totalSize)}</span>
                    <p className="text-xs text-gray-500 mt-1">{drive.fileSystem}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* スキャン設定 */}
      <div className="space-y-4 p-4 border border-gray-800 rounded-lg">
        <h3 className="text-sm font-medium text-gray-300">スキャン設定</h3>

        <div className="flex items-center gap-4">
          <label className="text-sm text-gray-400 whitespace-nowrap">対象期間:</label>
          <select
            value={daysBack}
            onChange={(e) => onDaysBackChange(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value={1}>直近1日</option>
            <option value={3}>直近3日</option>
            <option value={7}>直近1週間</option>
            <option value={14}>直近2週間</option>
            <option value={30}>直近1ヶ月</option>
          </select>
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enableCarving}
            onChange={(e) => onEnableCarvingChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
          />
          <div>
            <span className="text-sm text-gray-300">ファイルカービングを有効にする</span>
            <p className="text-xs text-gray-500">
              FAT復元で見つからないファイルをバイナリシグネチャで検出します（時間がかかります）
            </p>
          </div>
        </label>
      </div>

      {/* スキャン開始ボタン */}
      <button
        onClick={onStartScan}
        disabled={!selectedDrive}
        className={`w-full py-3 rounded-lg font-medium text-sm transition-colors ${
          selectedDrive
            ? 'bg-blue-600 hover:bg-blue-500 text-white'
            : 'bg-gray-800 text-gray-500 cursor-not-allowed'
        }`}
      >
        {selectedDrive
          ? `${selectedDrive.letter} をスキャン開始`
          : 'ドライブを選択してください'}
      </button>
    </div>
  )
}
