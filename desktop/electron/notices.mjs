import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

export async function dependencyNotices(root) {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const keys = lock.packages;
  const visited = new Set();
  const sections = [];
  const missing = [];
  const resolve = (name, parent = '') => {
    let directory = parent;
    while (true) {
      const key = path.posix.join(directory, 'node_modules', name);
      if (keys[key]) return key;
      if (!directory) return null;
      directory = path.posix.dirname(directory);
      if (directory === '.') directory = '';
    }
  };
  const visit = async key => {
    if (visited.has(key)) return;
    const folder = path.join(root, key);
    let pkg;
    try { pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && keys[key].optional) return; throw error; }
    visited.add(key);
    const licenses = (await readdir(folder)).filter(file => /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(file)).sort();
    const texts = [];
    for (const filename of licenses) {
      try { texts.push(`${filename}\n${await readFile(path.join(folder, filename), 'utf8')}`); }
      catch (error) { if (error.code !== 'EISDIR') throw error; }
    }
    if (!texts.length && pkg.name === 'glob-to-regexp' && pkg.version === '0.4.1') {
      texts.push(`README.md (includes the author's BSD-2-Clause text)\n${await readFile(path.join(folder, 'README.md'), 'utf8')}`);
    }
    if (!texts.length && pkg.name === '@esbuild/darwin-arm64' && pkg.version === '0.27.0') {
      const parent = resolve('esbuild', key);
      if (parent && keys[parent].version === pkg.version) texts.push(`esbuild/LICENSE.md (same version)\n${await readFile(path.join(root, parent, 'LICENSE.md'), 'utf8')}`);
    }
    const supplements = {
      'standardwebhooks@1.1.1': { license: 'MIT', file: 'standardwebhooks-1.1.1.txt', source: 'https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE' },
      'mcp-handler@2.1.1': { license: 'Apache-2.0', file: 'Apache-2.0.txt', source: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
      'type-fest@2.19.0': { license: '(MIT OR CC0-1.0)', file: 'CC0-1.0.txt', source: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt' },
    };
    const supplement = supplements[`${pkg.name}@${pkg.version}`];
    if (!texts.length && supplement && supplement.license === pkg.license) {
      texts.push(`Supplemental license text\nSource: ${supplement.source}\n${pkg.name === 'type-fest' ? 'Selected option: CC0-1.0, as offered by the package SPDX declaration.\n' : ''}${await readFile(path.join(root, 'desktop/legal', supplement.file), 'utf8')}`);
    }
    if (!pkg.license || texts.length === 0) missing.push(`${pkg.name}@${pkg.version}`);
    sections.push({ name: `${pkg.name}@${pkg.version}`, text: `${pkg.name}@${pkg.version}\nDeclared license: ${pkg.license ?? 'UNCONFIRMED'}\n\n${texts.join('\n\n') || 'No root license file found. Manual review required.'}` });
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const child = resolve(name, key);
      if (child) await visit(child);
      else if (!Object.hasOwn(pkg.optionalDependencies ?? {}, name)) throw Error(`Dependency missing from lockfile: ${name}`);
    }
  };
  for (const name of Object.keys({ ...keys[''].dependencies, '@clerk/electron': true, 'electron-store': true, 'node-pty': true })) {
    const key = resolve(name);
    if (!key) throw Error(`Desktop dependency missing: ${name}`);
    await visit(key);
  }
  return {
    count: visited.size, missing,
    text: 'bizencore terminal - Third-party notices\n\nGenerated from the locked installed dependency graph. Some listed dependencies may not be bundled.\nElectron/Chromium notices are also included with the Electron application runtime.\nThis inventory does not establish redistribution rights for images, fonts or other project assets.\n\n' +
      sections.sort((a, b) => a.name.localeCompare(b.name)).map(section => section.text).join('\n\n' + '='.repeat(72) + '\n\n') + '\n',
  };
}
