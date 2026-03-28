import { useState, useEffect, useCallback, useRef } from 'react'
import type { RecoveredFile, DriveInfo, ScanProgress } from '../../main/recovery/types'

export type AppStep = 'select-drive' | 'scanning' | 'file-list' | 'recovering' | 'complete'

interface RecoveryProgress {
  current: number
  total: number
  fileName: string
}

interface RecoveryResult {
  succeeded: string[]
  failed: { fileName: string; error: string }[]
}

const API = '/api'

export function useRecovery() {
  const [step, setStep] = useState<AppStep>('select-drive')
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [selectedDrive, setSelectedDrive] = useState<DriveInfo | null>(null)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [recoveredFiles, setRecoveredFiles] = useState<RecoveredFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [outputDir, setOutputDir] = useState<string>('')
  const [recoveryProgress, setRecoveryProgress] = useState<RecoveryProgress | null>(null)
  const [recoveryResult, setRecoveryResult] = useState<RecoveryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [daysBack, setDaysBack] = useState(7)
  const [enableCarving, setEnableCarving] = useState(true)

  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    refreshDrives()
    return () => {
      eventSourceRef.current?.close()
    }
  }, [])

  const refreshDrives = useCallback(async () => {
    try {
      const res = await fetch(`${API}/drives`)
      const list = await res.json()
      setDrives(list)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ドライブの取得に失敗しました')
    }
  }, [])

  const startScan = useCallback(async () => {
    if (!selectedDrive) return
    setError(null)
    setStep('scanning')
    setScanProgress(null)

    // SSEで進捗を受信
    const es = new EventSource(`${API}/scan/progress`)
    eventSourceRef.current = es
    es.onmessage = (event) => {
      const progress: ScanProgress = JSON.parse(event.data)
      setScanProgress(progress)
    }

    try {
      const res = await fetch(`${API}/scan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          drive: selectedDrive,
          enableCarving,
          daysBack
        })
      })

      es.close()
      eventSourceRef.current = null

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'スキャンに失敗しました')
      }

      const files: RecoveredFile[] = await res.json()
      setRecoveredFiles(files)
      setSelectedFiles(new Set(files.map(f => f.id)))
      setStep('file-list')
    } catch (err: unknown) {
      es.close()
      setError(err instanceof Error ? err.message : 'スキャンに失敗しました')
      setStep('select-drive')
    }
  }, [selectedDrive, enableCarving, daysBack])

  const abortScan = useCallback(async () => {
    eventSourceRef.current?.close()
    await fetch(`${API}/scan/abort`, { method: 'POST' })
    setStep('select-drive')
  }, [])

  const toggleFileSelection = useCallback((fileId: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  const selectAllFiles = useCallback(() => {
    setSelectedFiles(new Set(recoveredFiles.map(f => f.id)))
  }, [recoveredFiles])

  const deselectAllFiles = useCallback(() => {
    setSelectedFiles(new Set())
  }, [])

  const startRecovery = useCallback(async () => {
    if (!selectedDrive || !outputDir || selectedFiles.size === 0) return
    setError(null)
    setStep('recovering')
    setRecoveryProgress(null)

    // SSEで復元進捗を受信
    const es = new EventSource(`${API}/recovery/progress`)
    eventSourceRef.current = es
    es.onmessage = (event) => {
      setRecoveryProgress(JSON.parse(event.data))
    }

    try {
      const filesToRecover = recoveredFiles.filter(f => selectedFiles.has(f.id))
      const res = await fetch(`${API}/recovery/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: filesToRecover,
          physicalDrive: selectedDrive.physicalDrive,
          outputDir
        })
      })

      es.close()
      eventSourceRef.current = null

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || '復元に失敗しました')
      }

      const result: RecoveryResult = await res.json()
      setRecoveryResult(result)
      setStep('complete')
    } catch (err: unknown) {
      es.close()
      setError(err instanceof Error ? err.message : '復元に失敗しました')
      setStep('file-list')
    }
  }, [selectedDrive, outputDir, selectedFiles, recoveredFiles])

  const reset = useCallback(() => {
    setStep('select-drive')
    setSelectedDrive(null)
    setScanProgress(null)
    setRecoveredFiles([])
    setSelectedFiles(new Set())
    setOutputDir('')
    setRecoveryProgress(null)
    setRecoveryResult(null)
    setError(null)
    refreshDrives()
  }, [refreshDrives])

  return {
    step,
    drives,
    selectedDrive,
    setSelectedDrive,
    scanProgress,
    recoveredFiles,
    selectedFiles,
    toggleFileSelection,
    selectAllFiles,
    deselectAllFiles,
    outputDir,
    setOutputDir,
    recoveryProgress,
    recoveryResult,
    error,
    setError,
    daysBack,
    setDaysBack,
    enableCarving,
    setEnableCarving,
    refreshDrives,
    startScan,
    abortScan,
    startRecovery,
    reset
  }
}
