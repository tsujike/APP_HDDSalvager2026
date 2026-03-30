import { Router } from 'express'
import path from 'path'
import type { RecoveredFile, DriveInfo, ScanProgress, RecoveryOptions } from '../main/recovery/types.js'
import { RecoveryEngine } from '../main/recovery/recovery-engine.js'
import { detectDrives, isValidSDCard, formatSize } from '../main/drive/drive-detector.js'

export const apiRouter = Router()

/** デフォルト出力ディレクトリ */
const DEFAULT_OUTPUT_DIR = process.platform === 'win32'
  ? path.resolve(process.env.USERPROFILE || 'C:\\', 'HDDSalvager_Output')
  : '/output'

/** ドライブパスのバリデーション */
function isValidPhysicalDrive(drive: string): boolean {
  if (process.platform === 'win32') {
    // \\.\PhysicalDriveN または \\.\X: (ボリュームパス)
    return /^\\\\\.\\(PhysicalDrive\d+|[A-Z]:)$/i.test(drive)
  }
  return /^\/dev\/(sd[a-z]|mmcblk\d+)$/.test(drive)
}

/** 出力ディレクトリのバリデーション（絶対パス＋危険パス拒否） */
function isValidOutputDir(outputDir: string): boolean {
  if (!outputDir || outputDir.trim() === '') return false
  const resolved = path.resolve(outputDir)
  // パストラバーサル防止: ルートや危険なシステムディレクトリへの書き込みを拒否
  if (process.platform === 'win32') {
    const upper = resolved.toUpperCase()
    if (upper === 'C:\\' || upper === 'C:\\WINDOWS' || upper.startsWith('C:\\WINDOWS\\')) return false
  } else {
    if (resolved === '/' || resolved.startsWith('/proc') || resolved.startsWith('/sys')) return false
  }
  return true
}

// ──── セッション管理 ────

interface Session {
  engine: RecoveryEngine
  scanProgress: ScanProgress | null
  scanResult: RecoveredFile[] | null
  scanError: string | null
  recoveryProgress: { current: number; total: number; fileName: string } | null
  recoveryDone: boolean
}

/** セッションID → セッション状態 */
const sessions = new Map<string, Session>()

/** 新しいセッションIDを生成 */
function createSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** セッションを取得（なければ新規作成） */
function getOrCreateSession(sessionId?: string): [string, Session] {
  if (sessionId && sessions.has(sessionId)) {
    return [sessionId, sessions.get(sessionId)!]
  }
  const id = createSessionId()
  const session: Session = {
    engine: new RecoveryEngine(),
    scanProgress: null,
    scanResult: null,
    scanError: null,
    recoveryProgress: null,
    recoveryDone: false
  }
  sessions.set(id, session)
  return [id, session]
}

/** 古いセッションをクリーンアップ（アクティブなスキャン中は保護） */
function cleanupSessions(): void {
  const now = Date.now()
  for (const [id] of sessions) {
    const ts = parseInt(id.split('-')[0])
    const session = sessions.get(id)!
    // スキャン中またはスキャン完了直後のセッションは削除しない
    const isActive = session.scanProgress && session.scanProgress.phase !== 'complete'
    const maxAge = isActive ? 2 * 60 * 60 * 1000 : 30 * 60 * 1000 // アクティブ: 2時間, 非アクティブ: 30分
    if (now - ts > maxAge) {
      session.engine.abort()
      sessions.delete(id)
    }
  }
}

// 5分ごとにクリーンアップ
const cleanupTimer = setInterval(cleanupSessions, 5 * 60 * 1000)

/** グレースフルシャットダウン */
export function shutdownApi(): void {
  clearInterval(cleanupTimer)
  for (const [, session] of sessions) {
    session.engine.abort()
  }
  sessions.clear()
}

// ──── ドライブ ────

apiRouter.get('/drives', (_req, res) => {
  try {
    const drives = detectDrives()
    res.json(drives)
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) })
  }
})

apiRouter.post('/drives/validate', (req, res) => {
  const drive: DriveInfo = req.body
  if (!isValidSDCard(drive)) {
    res.json({
      valid: false,
      reason: `${drive.letter} は対応していないドライブです（FAT32/exFATの1GB〜1TBのドライブが必要です）`
    })
    return
  }
  res.json({ valid: true })
})

// ──── スキャン ────

apiRouter.post('/scan/start', (req, res) => {
  const { drive, enableCarving, daysBack } = req.body as {
    drive: DriveInfo
    enableCarving: boolean
    daysBack: number
  }

  // 入力バリデーション
  if (!drive?.physicalDrive || !isValidPhysicalDrive(drive.physicalDrive)) {
    res.status(400).json({ error: '無効なドライブパスです' })
    return
  }
  if (typeof daysBack !== 'number' || daysBack < 1 || daysBack > 365) {
    res.status(400).json({ error: 'daysBack は 1〜365 の整数で指定してください' })
    return
  }

  const [sessionId, session] = getOrCreateSession()
  session.scanProgress = null
  session.scanResult = null
  session.scanError = null

  const afterDate = Date.now() - daysBack * 24 * 60 * 60 * 1000
  const options: RecoveryOptions = {
    drive,
    afterDate,
    outputDir: '',
    enableCarving
  }

  // スキャンをバックグラウンドで開始し、即座にsessionIdを返す
  session.engine.scan(options, (progress) => {
    // 'complete'はscanResult設定後にここで発行する（下記.then参照）
    if (progress.phase !== 'complete') {
      session.scanProgress = progress
    }
  }).then((files) => {
    // scanResultを先にセットしてから'complete'を通知（順序保証）
    session.scanResult = files
    session.scanProgress = {
      phase: 'complete',
      percent: 100,
      currentSector: 0,
      totalSectors: 0,
      filesFound: files.length
    }
  }).catch((err: unknown) => {
    session.scanError = err instanceof Error ? err.message : String(err)
    // エラー時もSSEを終了させる
    session.scanProgress = {
      phase: 'complete',
      percent: 100,
      currentSector: 0,
      totalSectors: 0,
      filesFound: 0
    }
  })

  res.json({ sessionId })
})

// スキャン結果を取得（スキャン完了後に呼び出し）
apiRouter.get('/scan/result', (req, res) => {
  const sessionId = req.query.sessionId as string | undefined
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: 'セッションが見つかりません' })
    return
  }
  const session = sessions.get(sessionId)!
  if (session.scanError) {
    res.status(500).json({ error: session.scanError })
    return
  }
  if (!session.scanResult) {
    res.status(202).json({ status: 'scanning' })
    return
  }
  res.json({ files: session.scanResult })
})

apiRouter.post('/scan/abort', (req, res) => {
  const { sessionId } = req.body as { sessionId?: string }
  if (sessionId && sessions.has(sessionId)) {
    sessions.get(sessionId)!.engine.abort()
  }
  res.json({ ok: true })
})

// SSE: スキャン進捗をストリーム配信
apiRouter.get('/scan/progress', (req, res) => {
  const sessionId = req.query.sessionId as string | undefined
  const session = sessionId ? sessions.get(sessionId) : undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(() => {
    const progress = session?.scanProgress
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`)
      if (progress.phase === 'complete') {
        clearInterval(interval)
        res.end()
      }
    }
  }, 300)

  req.on('close', () => {
    clearInterval(interval)
  })
})

// ──── 復元 ────

apiRouter.post('/recovery/start', async (req, res) => {
  const { sessionId, files, physicalDrive, outputDir } = req.body as {
    sessionId?: string
    files: RecoveredFile[]
    physicalDrive: string
    outputDir: string
  }

  // 入力バリデーション
  if (!isValidPhysicalDrive(physicalDrive)) {
    res.status(400).json({ error: '無効なドライブパスです' })
    return
  }
  if (!isValidOutputDir(outputDir)) {
    res.status(400).json({ error: '有効な出力先フォルダを指定してください' })
    return
  }
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: '復元するファイルを選択してください' })
    return
  }

  const [sid, session] = getOrCreateSession(sessionId)
  session.recoveryProgress = null
  session.recoveryDone = false

  try {
    const result = await session.engine.recover(files, physicalDrive, outputDir, (current, total, fileName) => {
      session.recoveryProgress = { current, total, fileName }
    })
    session.recoveryDone = true
    res.json({ sessionId: sid, ...result })
  } catch (err: unknown) {
    session.recoveryDone = true
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// SSE: 復元進捗
apiRouter.get('/recovery/progress', (req, res) => {
  const sessionId = req.query.sessionId as string | undefined
  const session = sessionId ? sessions.get(sessionId) : undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(() => {
    const progress = session?.recoveryProgress
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`)
      // 復元完了時にSSEを終了
      if (session?.recoveryDone) {
        res.write(`data: ${JSON.stringify({ ...progress, done: true })}\n\n`)
        clearInterval(interval)
        res.end()
      }
    }
  }, 300)

  req.on('close', () => {
    clearInterval(interval)
  })
})

// ──── ユーティリティ ────

apiRouter.get('/config/defaults', (_req, res) => {
  res.json({ daysBack: 7, enableCarving: true, outputDir: DEFAULT_OUTPUT_DIR })
})

apiRouter.get('/util/format-size/:bytes', (req, res) => {
  res.json({ formatted: formatSize(Number(req.params.bytes)) })
})
