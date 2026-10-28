import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // agent-cli is the standalone helper AI tools and git launch; see src/main/agent/paths.ts
        input: { index: resolve('src/main/index.ts'), 'agent-cli': resolve('src/main/agent-cli.ts') }
      }
    }
  },
  preload: {},
  renderer: { plugins: [react()] }
})
