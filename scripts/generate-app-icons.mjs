import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const source = 'https://raw.githubusercontent.com/google/fonts/0b58fb370093f9a9f4ff785d94405710b79de67c/ofl/instrumentserif';
const fonts = [];
for (const style of ['Regular', 'Italic']) {
  const response = await fetch(`${source}/InstrumentSerif-${style}.ttf`);
  if (!response.ok) throw new Error(`Font download failed: ${response.status}`);
  fonts.push(Buffer.from(await response.arrayBuffer()).toString('base64'));
}
const root = fileURLToPath(new URL('../public/', import.meta.url));
const sizes = { 'favicon.png': 32, 'apple-touch-icon.png': 180, 'icons/icon-192.png': 192, 'icons/icon-512.png': 512 };
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROME_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const icons = await page.evaluate(async ({ fonts, sizes }) => {
    for (const [index, style] of ['normal', 'italic'].entries()) {
      const face = new FontFace('Instrument Serif Icon', `url(data:font/ttf;base64,${fonts[index]})`, { style });
      await face.load();
      document.fonts.add(face);
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2048;
    const ctx = canvas.getContext('2d');
    const em = 1000;
    ctx.font = `${em}px "Instrument Serif Icon"`;
    const b = ctx.measureText('b');
    ctx.font = `italic ${em}px "Instrument Serif Icon"`;
    const c = ctx.measureText('c');
    const cOrigin = b.width - em * 0.025;
    const left = Math.min(-b.actualBoundingBoxLeft, cOrigin - c.actualBoundingBoxLeft);
    const right = Math.max(b.actualBoundingBoxRight, cOrigin + c.actualBoundingBoxRight);
    const ascent = Math.max(b.actualBoundingBoxAscent, c.actualBoundingBoxAscent);
    const descent = Math.max(b.actualBoundingBoxDescent, c.actualBoundingBoxDescent);
    const width = right - left;
    const height = ascent + descent;
    // Keep every glyph inside Android's central safe circle, including italic overhang.
    const scale = (canvas.width * 0.375) / Math.hypot(width / 2, height / 2);
    const x = canvas.width / 2 - (left + right) * scale / 2;
    const baseline = canvas.height / 2 + (ascent - descent) * scale / 2;
    ctx.fillStyle = '#0a0b0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${em * scale}px "Instrument Serif Icon"`;
    ctx.fillText('b', x, baseline);
    ctx.font = `italic ${em * scale}px "Instrument Serif Icon"`;
    ctx.fillText('c', x + cOrigin * scale, baseline);
    return Object.entries(sizes).map(([name, size]) => {
      const icon = document.createElement('canvas');
      icon.width = icon.height = size;
      const output = icon.getContext('2d');
      output.imageSmoothingQuality = 'high';
      output.drawImage(canvas, 0, 0, size, size);
      return { name, png: icon.toDataURL('image/png').split(',')[1] };
    });
  }, { fonts, sizes });
  await mkdir(`${root}/icons`, { recursive: true });
  for (const { name, png } of icons) {
    const bytes = Buffer.from(png, 'base64');
    assert.equal(bytes.readUInt32BE(16), sizes[name]);
    await writeFile(`${root}/${name}`, bytes);
    console.log(`${name}: ${sizes[name]}px (${bytes.length} bytes)`);
  }
} finally {
  await browser.close();
}
