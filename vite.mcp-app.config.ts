import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'mcp-app',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist-mcp',
    emptyOutDir: true,
  },
});
