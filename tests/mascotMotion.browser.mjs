import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { MascotPortrait } from './src/components/MascotPortrait';
    function Fixture() {
      const [active, setActive] = useState(true); globalThis.setPortraitActive = setActive;
      return <div className="mascot-container mascot-container--handoff"><button className="mascot-button"><MascotPortrait active={active} /></button></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await readFile('src/index.css', 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
    Math.random = () => 0;
    globalThis.blinks = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.classList.contains('mascot-eye')) globalThis.blinks.push({ frames, options });
      return animate.call(this, frames, options);
    };
  });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${outputFiles[0].text}</script>` }));
  await page.goto('https://portrait.test/');
  const portrait = page.locator('.mascot-portrait'); await portrait.waitFor();
  await page.waitForFunction(() => [...document.images].every(img => img.complete));
  await page.locator('.mascot-face').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.mascot').evaluate(el => getComputedStyle(el).animationName), 'none', 'there is no constant floating');
  const center = await portrait.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const state = () => portrait.evaluate(el => ({ rotate: parseFloat(el.style.rotate), gaze: el.querySelector('.mascot-gaze').style.transform }));
  await page.mouse.move(center.x + 50, center.y - 20);
  let current = await state(); assert.ok(current.rotate > 0 && current.rotate < 3.5); assert.notEqual(current.gaze, 'translate(0px, 0px)');
  await page.clock.runFor(600);
  await page.screenshot({ path: '/private/tmp/bizencore-cirno-looking.png' });
  await page.mouse.move(650, 50);
  current = await state(); assert.equal(current.rotate, 0); assert.equal(current.gaze, 'translate(0px, 0px)');
  await page.clock.runFor(3500);
  assert.equal(await page.evaluate(() => blinks.length), 2, 'both eyes blink after four seconds');
  const blink = await page.evaluate(() => blinks[0]); assert.equal(blink.options.duration, 160); assert.equal(blink.frames[1].scale, '1 0.08');
  await page.evaluate(() => document.querySelectorAll('.mascot-eye').forEach(eye => eye.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 72; })));
  await page.addStyleTag({ content: '.mascot { width: 324px; }' });
  await page.screenshot({ path: '/private/tmp/bizencore-cirno-blink.png' });
  const setMotion = async value => {
    await page.evaluate(() => { globalThis.motionChanged = new Promise(resolve => matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => resolve(true), { once: true })); });
    await page.emulateMedia({ reducedMotion: value });
    await page.evaluate(() => motionChanged);
  };
  await setMotion('reduce');
  const before = await page.evaluate(() => blinks.length);
  await page.clock.runFor(10_000);
  await page.mouse.move(center.x + 40, center.y);
  assert.equal((await state()).rotate, 0); assert.equal(await page.evaluate(() => blinks.length), before, 'reduced motion stops blinking and tracking');
  assert.equal(await page.locator('.mascot-eye').evaluateAll(eyes => eyes.reduce((n, eye) => n + eye.getAnimations().length, 0)), 0);
  await setMotion('no-preference');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(10_000);
  assert.equal(await page.evaluate(() => blinks.length), before, 'hidden windows stop timers');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(4001); assert.equal(await page.evaluate(() => blinks.length), before + 2, 'visibility restores blinking');
  await page.evaluate(() => setPortraitActive(false));
  await page.waitForFunction(() => document.querySelector('.mascot-portrait').style.rotate === '0deg');
  const paused = await page.evaluate(() => blinks.length); await page.clock.runFor(10_000);
  assert.equal(await page.evaluate(() => blinks.length), paused, 'dragging/menu pause stops motion');
  await page.evaluate(() => setPortraitActive(true)); await page.clock.runFor(1);
  const largeCenter = await portrait.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.evaluate(({ x, y }) => document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: x + 40, clientY: y })), largeCenter);
  assert.equal((await state()).rotate, 0, 'touch does not create a lingering gaze');
  await page.clock.runFor(600);
  await page.screenshot({ path: '/private/tmp/bizencore-cirno-idle.png' });
  await page.locator('.mascot-face image').evaluate(el => el.setAttribute('href', 'data:image/png;base64,invalid'));
  await page.locator('.mascot-face').waitFor({ state: 'hidden' });
  assert.equal((await state()).rotate, 0);
  assert.ok(await page.locator('.mascot').evaluate(el => el.complete && el.naturalWidth > 0), 'failed animation asset leaves the original artwork visible');
  assert.deepEqual(errors, []);
  console.log('Passed: subtle nearby gaze/tilt and reset, irregular blink interval, no idle float, reduced motion, hidden-window pause, drag/menu pause, touch and error-free rendering.');
} finally { await browser.close(); }
