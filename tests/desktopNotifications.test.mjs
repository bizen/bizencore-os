import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopNotifications, externalWebUrl } from '../desktop/electron/notifications.mjs';

const paneId = '662a5ff1-a990-4c90-a9bd-2a773844da3c';
test('external links cannot launch commands or carry URL credentials', () => {
  for (const link of ['javascript:alert(1)', 'file:///tmp/x', 'bizencore-terminal://renderer', 'https://user:secret@example.com']) assert.throws(() => externalWebUrl(link));
  assert.equal(externalWebUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(externalWebUrl('http://127.0.0.1:1234/callback'), 'http://127.0.0.1:1234/callback');
});

test('background notifications are bounded, rate limited and focus only an existing pane', () => {
  const messages = [], focused = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(value) { super(); this.value = value; messages.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }
  let foreground = true, now = 1000;
  const notifications = createDesktopNotifications({ Notification, isFocused: () => foreground, focusPane: id => focused.push(id), clock: () => now });
  const value = { paneId, title: 'Task completed', body: 'Verified synchronized task' };
  assert.equal(notifications.notify(value), false);
  foreground = false;
  assert.equal(notifications.notify(value), true);
  assert.equal(notifications.notify(value), false);
  messages[0].emit('click');
  assert.deepEqual(focused, [paneId]);
  now += 5001;
  assert.equal(notifications.notify(value), true);
  assert.equal(messages[0].closed, true);
  notifications.clear();
  assert.equal(messages[1].closed, true);
  assert.throws(() => notifications.notify({ ...value, paneId: '../../file' }));
  assert.throws(() => notifications.notify({ ...value, body: 'x'.repeat(501) }));
});
