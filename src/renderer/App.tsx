import { useRecovery } from './hooks/useRecovery'
import { DriveSelector } from './components/DriveSelector'
import { ScanProgress } from './components/ScanProgress'
import { FileList } from './components/FileList'
import { RecoveryComplete } from './components/RecoveryComplete'

export default function App() {
  const recovery = useRecovery()

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* ヘッダー */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-sm font-bold">
            S
          </div>
          <div>
            <h1 className="text-lg font-semibold">HDD Salvager 2026</h1>
            <p className="text-xs text-gray-500">GoPro SD Card Recovery Tool</p>
          </div>
        </div>
      </header>

      {/* エラー表示 */}
      {recovery.error && (
        <div className="mx-6 mt-4 p-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm flex items-center justify-between">
          <span>{recovery.error}</span>
          <button
            onClick={() => recovery.setError(null)}
            className="text-red-400 hover:text-red-200 ml-4"
          >
            x
          </button>
        </div>
      )}

      {/* メインコンテンツ */}
      <main className="flex-1 p-6">
        {recovery.step === 'select-drive' && (
          <DriveSelector
            drives={recovery.drives}
            selectedDrive={recovery.selectedDrive}
            onSelectDrive={recovery.setSelectedDrive}
            onRefresh={recovery.refreshDrives}
            daysBack={recovery.daysBack}
            onDaysBackChange={recovery.setDaysBack}
            enableCarving={recovery.enableCarving}
            onEnableCarvingChange={recovery.setEnableCarving}
            onStartScan={recovery.startScan}
          />
        )}

        {recovery.step === 'scanning' && (
          <ScanProgress
            progress={recovery.scanProgress}
            onAbort={recovery.abortScan}
          />
        )}

        {(recovery.step === 'file-list' || recovery.step === 'recovering') && (
          <FileList
            files={recovery.recoveredFiles}
            selectedFiles={recovery.selectedFiles}
            onToggleFile={recovery.toggleFileSelection}
            onSelectAll={recovery.selectAllFiles}
            onDeselectAll={recovery.deselectAllFiles}
            outputDir={recovery.outputDir}
            onOutputDirChange={recovery.setOutputDir}
            onStartRecovery={recovery.startRecovery}
            isRecovering={recovery.step === 'recovering'}
            recoveryProgress={recovery.recoveryProgress}
          />
        )}

        {recovery.step === 'complete' && (
          <RecoveryComplete
            result={recovery.recoveryResult}
            onReset={recovery.reset}
            onBackToFiles={recovery.backToFiles}
          />
        )}
      </main>

      {/* フッター */}
      <footer className="border-t border-gray-800 px-6 py-3 text-xs text-gray-600">
        <div className="flex justify-between">
          <span>SDカードへの書き込みは一切行いません（読み取り専用）</span>
          <span>管理者権限で実行中</span>
        </div>
      </footer>
    </div>
  )
}
