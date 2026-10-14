import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'mcp-app',
  // Inline every asset without passing patterns to the build-only glob parser.
  plugins: [react(), viteSingleFile({ inlinePattern: [] })],
  build: {
    outDir: '../dist-mcp',
    emptyOutDir: true,
  },
});
