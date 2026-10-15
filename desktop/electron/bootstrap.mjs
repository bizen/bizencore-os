if (process.argv.includes('--auth-storage-worker')) await import('./auth-storage-worker.mjs');
else await import('./main.mjs');
