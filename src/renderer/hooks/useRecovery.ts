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
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    refreshDrives()
    // デフォルト設定をサーバーから取得
    fetch(`${API}/config/defaults`).then(r => r.json()).then(data => {
      if (data.outputDir) setOutputDir(data.outputDir)
    }).catch(() => {})
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

    try {
      // 1. スキャンをバックグラウンドで開始（即座にsessionId返却）
      const res = await fetch(`${API}/scan/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          drive: selectedDrive,
          enableCarving,
          daysBack
        })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'スキャンに失敗しました')
      }

      const { sessionId } = await res.json()
      sessionIdRef.current = sessionId

      // 2. SSEで進捗をリアルタイム受信
      const files = await new Promise<RecoveredFile[]>((resolve, reject) => {
        const es = new EventSource(`${API}/scan/progress?sessionId=${sessionId}`)
        eventSourceRef.current = es

        const fetchResult = async (retries = 3): Promise<RecoveredFile[]> => {
          for (let i = 0; i < retries; i++) {
            const r = await fetch(`${API}/scan/result?sessionId=${sessionId}`)
            if (r.status === 202) {
              // まだ結果が準備できていない → 少し待ってリトライ
              await new Promise(res => setTimeout(res, 500))
              continue
            }
            if (!r.ok) {
              const err = await r.json()
              throw new Error(err.error || 'スキャン結果の取得に失敗しました')
            }
            const data = await r.json()
            return data.files ?? []
          }
          throw new Error('スキャン結果の取得がタイムアウトしました')
        }

        es.onmessage = (event) => {
          const progress: ScanProgress = JSON.parse(event.data)
          setScanProgress(progress)

          if (progress.phase === 'complete') {
            es.close()
            eventSourceRef.current = null
            fetchResult().then(resolve).catch(reject)
          }
        }

        es.onerror = () => {
          es.close()
          eventSourceRef.current = null
          reject(new Error('スキャン進捗の接続が切れました'))
        }
      })

      setRecoveredFiles(files)
      setSelectedFiles(new Set(files.map(f => f.id)))
      setStep('file-list')
    } catch (err: unknown) {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      setError(err instanceof Error ? err.message : 'スキャンに失敗しました')
      setStep('select-drive')
    }
  }, [selectedDrive, enableCarving, daysBack])

  const abortScan = useCallback(async () => {
    eventSourceRef.current?.close()
    await fetch(`${API}/scan/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionIdRef.current })
    })
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

    // SSEで復元進捗を受信（セッションID付き）
    const sseUrl = sessionIdRef.current
      ? `${API}/recovery/progress?sessionId=${sessionIdRef.current}`
      : `${API}/recovery/progress`
    const es = new EventSource(sseUrl)
    eventSourceRef.current = es
    es.onmessage = (event) => {
      const data = JSON.parse(event.data)
      setRecoveryProgress(data)
      if (data.done) {
        es.close()
      }
    }

    try {
      const filesToRecover = recoveredFiles.filter(f => selectedFiles.has(f.id))
      const res = await fetch(`${API}/recovery/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
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

  const backToFiles = useCallback(() => {
    setStep('file-list')
    setRecoveryProgress(null)
    setRecoveryResult(null)
    setError(null)
  }, [])

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
    sessionIdRef.current = null
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
    backToFiles,
    reset
  }
}
