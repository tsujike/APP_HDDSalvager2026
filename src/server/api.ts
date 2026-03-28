import { Router } from 'express'
import type { RecoveredFile, DriveInfo, ScanProgress, RecoveryOptions } from '../main/recovery/types.js'
import { RecoveryEngine } from '../main/recovery/recovery-engine.js'
import { detectDrives, isValidSDCard, formatSize } from '../main/drive/drive-detector.js'

export const apiRouter = Router()

/** アクティブなエンジンインスタンス（スキャンごとに1つ） */
let engine: RecoveryEngine | null = null

/** 直近のスキャン進捗（SSEで配信） */
let lastProgress: ScanProgress | null = null

/** 直近の復元進捗 */
let lastRecoveryProgress: { current: number; total: number; fileName: string } | null = null

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

apiRouter.post('/scan/start', async (req, res) => {
  const { drive, enableCarving, daysBack } = req.body as {
    drive: DriveInfo
    enableCarving: boolean
    daysBack: number
  }

  engine = new RecoveryEngine()
  lastProgress = null

  const afterDate = Date.now() - daysBack * 24 * 60 * 60 * 1000
  const options: RecoveryOptions = {
    drive,
    afterDate,
    outputDir: '',
    enableCarving
  }

  try {
    const files = await engine.scan(options, (progress) => {
      lastProgress = progress
    })
    res.json(files)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

apiRouter.post('/scan/abort', (_req, res) => {
  engine?.abort()
  res.json({ ok: true })
})

// SSE: スキャン進捗をストリーム配信
apiRouter.get('/scan/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(() => {
    if (lastProgress) {
      res.write(`data: ${JSON.stringify(lastProgress)}\n\n`)
      if (lastProgress.phase === 'complete') {
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
  const { files, physicalDrive, outputDir } = req.body as {
    files: RecoveredFile[]
    physicalDrive: string
    outputDir: string
  }

  if (!engine) engine = new RecoveryEngine()
  lastRecoveryProgress = null

  try {
    const result = await engine.recover(files, physicalDrive, outputDir, (current, total, fileName) => {
      lastRecoveryProgress = { current, total, fileName }
    })
    res.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// SSE: 復元進捗
apiRouter.get('/recovery/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(() => {
    if (lastRecoveryProgress) {
      res.write(`data: ${JSON.stringify(lastRecoveryProgress)}\n\n`)
    }
  }, 300)

  req.on('close', () => {
    clearInterval(interval)
  })
})

// ──── ユーティリティ ────

apiRouter.get('/config/defaults', (_req, res) => {
  res.json({ daysBack: 7, enableCarving: true })
})

apiRouter.get('/util/format-size/:bytes', (req, res) => {
  res.json({ formatted: formatSize(Number(req.params.bytes)) })
})
