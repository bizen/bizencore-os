import { cp, mkdir, readdir, stat, symlink, readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const configureOnly = process.argv.includes('--configure-only');
const folders = process.argv.slice(2).filter(value => value !== '--configure-only');
if (!folders.length) throw Error('Provide dedicated temporary agent folders.');
const entries = (await readdir(root)).filter(name =>
  ['src', 'desktop', 'api', 'convex', 'tests', 'mcp-app', 'public', 'index.html', 'package.json'].includes(name) ||
  /^tsconfig.*\.json$/.test(name) || /^vite.*\.ts$/.test(name));
for (const folder of folders) {
  const base = await stat(folder);
  if (!folder.startsWith('/private/tmp/bizencore-scale-') || !base.isDirectory()) throw Error('Not a dedicated test folder.');
  const target = path.join(folder, 'project-check');
  if (!configureOnly) {
    await mkdir(target); // Do not overwrite earlier evidence.
    for (const name of entries) await cp(path.join(root, name), path.join(target, name), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(target, 'node_modules'));
  }
  // Shared dependencies are read-only; each workload owns its build caches.
  for (const name of entries.filter(name => /^tsconfig.*\.json$/.test(name))) {
    const file = path.join(target, name);
    const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, 'utf8'));
    if (parsed.error) throw Error(`Invalid fixture config: ${name}`);
    if (parsed.config.compilerOptions?.tsBuildInfoFile) {
      parsed.config.compilerOptions.tsBuildInfoFile = `./.check-cache/${name}.tsbuildinfo`;
      await writeFile(file, JSON.stringify(parsed.config, null, 2) + '\n');
    }
  }
  const packageFile = path.join(target, 'package.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  manifest.scripts.build = manifest.scripts.build.replace(/vite build(?! --configLoader)/g, 'vite build --configLoader runner');
  await writeFile(packageFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(target);
}
