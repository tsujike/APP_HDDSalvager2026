import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { apiRouter, shutdownApi } from './api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = process.env.PORT ?? 3000

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173']
}))
app.use(express.json({ limit: '50mb' }))

// API routes
app.use('/api', apiRouter)

// 本番時: Viteビルド済み静的ファイルを配信
const clientDist = path.resolve(__dirname, '../../client')
app.use(express.static(clientDist))

// GETリクエストのみindex.htmlにフォールバック（SPA対応）
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

const server = app.listen(PORT, () => {
  console.log(`HDD Salvager 2026 running at http://localhost:${PORT}`)
})

// グレースフルシャットダウン
function shutdown(signal: string): void {
  console.log(`\n${signal} received. Shutting down...`)
  shutdownApi()
  server.close(() => {
    console.log('Server closed.')
    process.exit(0)
  })
  // 5秒以内に終了しなければ強制終了
  setTimeout(() => process.exit(1), 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
