import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { apiRouter } from './api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = process.env.PORT ?? 3000

app.use(cors())
app.use(express.json())

// API routes
app.use('/api', apiRouter)

// 本番時: Viteビルド済み静的ファイルを配信
const clientDist = path.resolve(__dirname, '../../dist/client')
app.use(express.static(clientDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

app.listen(PORT, () => {
  console.log(`HDD Salvager 2026 running at http://localhost:${PORT}`)
})
