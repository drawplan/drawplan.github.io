import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

const git = (cmd: string) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

// 0.<year-2025>.<MMDD> — minor counts years from 2026, build is the build date
const now = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const version = `0.${now.getFullYear() - 2025}.${pad(now.getMonth() + 1)}${pad(now.getDate())}`
const hash = git('git rev-parse --short HEAD')
const dirty = git('git status --porcelain') ? '-dirty' : ''
const fullVersion = hash ? `${version}+${hash}${dirty}` : version

export default defineConfig({
  plugins: [react()],
  server: { port: 8080, host: true },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_VERSION_FULL__: JSON.stringify(fullVersion),
  },
})
