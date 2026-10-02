import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'mcp-app',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../dist-mcp',
    emptyOutDir: true,
  },
});
