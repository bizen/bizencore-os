import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const BUNDLE = 'bizencore terminal.app';
// Validate every archive path before ditto can create files or follow a link.
export async function validateUpdateArchive(filename) {
  const file = await open(filename, 'r');
  try {
    const { size } = await file.stat();
    const read = async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size) throw Error('Invalid update archive');
      const bytes = Buffer.alloc(length);
      if ((await file.read(bytes, 0, length, offset)).bytesRead !== length) throw Error('Incomplete update archive');
      return bytes;
    };
    const tailOffset = Math.max(0, size - 65557), tail = await read(tailOffset, size - tailOffset);
    let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
    if (end < 0) throw Error('Invalid ZIP directory');
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (tail.readUInt32LE(end + 4) || tail.readUInt16LE(end + 8) !== count || count === 65535 ||
        directorySize > 16 * 1024 * 1024 || offset + directorySize !== tailOffset + end) throw Error('Unsupported ZIP directory');
    const directory = await read(offset, directorySize), paths = new Set(), links = new Set();
    let cursor = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw Error('Invalid ZIP entry');
      const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10);
      const compressed = directory.readUInt32LE(cursor + 20), unpacked = directory.readUInt32LE(cursor + 24);
      const nameSize = directory.readUInt16LE(cursor + 28), extraSize = directory.readUInt16LE(cursor + 30), commentSize = directory.readUInt16LE(cursor + 32);
      const next = cursor + 46 + nameSize + extraSize + commentSize;
      if (next > directory.length || directory.readUInt16LE(cursor + 34) || (flags & 1) || ![0, 8].includes(method)) throw Error('Unsupported ZIP entry');
      const name = directory.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8').replace(/\/$/, '');
      const parts = name.split('/');
      if (![BUNDLE, '__MACOSX'].includes(parts[0]) || parts.some(part => !part || part === '.' || part === '..') ||
          /[\\\x00-\x1f\x7f]/.test(name) || paths.has(name)) throw Error('Unsafe ZIP path');
      paths.add(name); expanded += unpacked;
      if (expanded > 2 * 1024 ** 3) throw Error('Update archive is too large');
      const mode = directory.readUInt32LE(cursor + 38) >>> 16, kind = mode & 0o170000;
      if (![0, 0o040000, 0o100000, 0o120000].includes(kind)) throw Error('Unsupported ZIP file type');
      const localOffset = directory.readUInt32LE(cursor + 42), local = await read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw Error('Invalid ZIP local entry');
      const localNameSize = local.readUInt16LE(26), localExtraSize = local.readUInt16LE(28);
      const localName = (await read(localOffset + 30, localNameSize)).toString('utf8').replace(/\/$/, '');
      if (localName !== name || localOffset + 30 + localNameSize + localExtraSize + compressed > offset) throw Error('Invalid ZIP entry bounds');
      if (kind === 0o120000) {
        if (compressed > 4096 || unpacked > 4096) throw Error('Invalid ZIP link');
        const bytes = await read(localOffset + 30 + localNameSize + localExtraSize, compressed);
        const target = (method === 8 ? inflateRawSync(bytes, { maxOutputLength: 4096 }) : bytes).toString('utf8');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (!target || target.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(target) || !resolved.startsWith(`${BUNDLE}/`)) throw Error('Unsafe ZIP link');
        links.add(name);
      }
      cursor = next;
    }
    if (cursor !== directory.length || !paths.has(`${BUNDLE}/Contents/Info.plist`)) throw Error('Update bundle is missing');
    for (const name of paths) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') {
        if (links.has(parent)) throw Error('ZIP entry traverses a symbolic link');
        parent = path.posix.dirname(parent);
      }
    }
  } finally { await file.close(); }
}
