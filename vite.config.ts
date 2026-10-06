import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { randomUUID } from 'node:crypto'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const buildId = command === 'build' ? randomUUID() : '';
  return {
    define: { 'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId) },
    plugins: [react(), {
      name: 'app-build-version',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }) });
      },
    }],
  };
})
