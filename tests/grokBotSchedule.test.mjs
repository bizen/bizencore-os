import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

async function load(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const [{ normalizeClockInTimes, nextClockIn }, { dateInTimeZone }, { deadlineInstant }] = await Promise.all([
  load('src/lib/grokBotSchedule.ts'), load('src/lib/taskDates.ts'), load('src/lib/taskNotifications.ts'),
]);
const zone = 'Australia/Melbourne';
const at = local => Date.parse(local);

/** The daily patrol as it was before clock-ins: one run per calendar day. */
function legacyNextPatrol(time, timeZone, now, lastRunAt) {
  const start = Date.parse(`${dateInTimeZone(timeZone, now)}T00:00:00Z`);
  const lastDay = lastRunAt ? dateInTimeZone(timeZone, lastRunAt) : undefined;
  for (let offset = 0; offset < 4; offset++) {
    const day = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
    if (lastDay === day) continue;
    const instant = deadlineInstant(day, time, timeZone);
    if (instant !== null && instant >= Math.floor(now / 60_000) * 60_000) return instant;
  }
}

test('clock-in times are valid, unique, ascending and at most six', () => {
  assert.deepEqual(normalizeClockInTimes(['18:00', ' 09:00', '18:00', '25:00', '', '7:00']), ['09:00', '18:00']);
  assert.deepEqual(normalizeClockInTimes(['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00']), ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00']);
  assert.deepEqual(normalizeClockInTimes(undefined, '06:00'), ['06:00']);
  assert.deepEqual(normalizeClockInTimes([], '06:00'), ['06:00']);
  assert.deepEqual(normalizeClockInTimes(['nope'], 'bad'), []);
});

test('a single time keeps the original once-a-day patrol exactly', () => {
  const times = ['00:00', '03:15', '12:00', '23:59'];
  const nows = ['2026-11-13T00:00:00+11:00', '2026-11-13T03:15:30+11:00', '2026-11-13T12:00:59+11:00', '2026-11-13T23:59:00+11:00', '2026-10-04T01:00:00+10:00'];
  for (const time of times) for (const now of nows) for (const last of [undefined, at('2026-11-13T03:15:00+11:00'), at('2026-11-12T23:00:00+11:00')]) {
    assert.equal(nextClockIn([time], zone, at(now), last), legacyNextPatrol(time, zone, at(now), last), `${time} at ${now} after ${last}`);
  }
  assert.equal(nextClockIn(['03:15'], zone, at('2026-11-13T12:00:00+11:00')), at('2026-11-14T03:15:00+11:00'));
  assert.equal(nextClockIn(['12:00'], zone, at('2026-11-13T12:00:40+11:00')), at('2026-11-13T12:00:00+11:00'), 'the current minute still counts');
  assert.equal(nextClockIn(['15:00'], zone, at('2026-11-13T12:00:00+11:00'), at('2026-11-13T06:00:00+11:00')), at('2026-11-14T15:00:00+11:00'),
    'a run earlier the same day uses up that day');
});

test('several times clock in at each slot once, in order across days', () => {
  const times = ['09:00', '13:00', '18:00'];
  assert.equal(nextClockIn(times, zone, at('2026-11-13T12:00:00+11:00')), at('2026-11-13T13:00:00+11:00'));
  assert.equal(nextClockIn(times, zone, at('2026-11-13T07:00:00+11:00'), at('2026-11-12T18:00:00+11:00')), at('2026-11-13T09:00:00+11:00'),
    'a run yesterday never blocks today');
  const slot = at('2026-11-13T13:00:00+11:00');
  assert.equal(nextClockIn(times, zone, slot + 30_000, undefined, String(slot)), at('2026-11-13T18:00:00+11:00'), 'a fired slot is not repeated');
  assert.equal(nextClockIn(times, zone, slot + 30_000, slot + 5_000), at('2026-11-13T18:00:00+11:00'), 'a run in the slot minute counts as fired');
  assert.equal(nextClockIn(times, zone, at('2026-11-13T18:00:10+11:00'), undefined, String(slot)), at('2026-11-13T18:00:00+11:00'));
  assert.equal(nextClockIn(times, zone, at('2026-11-13T19:00:00+11:00')), at('2026-11-14T09:00:00+11:00'));
});

test('clock-ins cross midnight and skip times a DST change removes', () => {
  const late = at('2026-11-13T23:30:00+11:00');
  assert.equal(nextClockIn(['00:00', '23:30'], zone, late + 20_000, undefined, String(late)), at('2026-11-14T00:00:00+11:00'));
  // Melbourne springs forward on 2026-10-04 at 02:00, so 02:30 does not exist that day.
  assert.equal(nextClockIn(['02:30', '09:00'], zone, at('2026-10-04T00:00:00+10:00')), at('2026-10-04T09:00:00+11:00'));
  assert.equal(nextClockIn(['02:30'], zone, at('2026-10-04T00:00:00+10:00')), at('2026-10-05T02:30:00+11:00'));
  // On 2027-04-04 clocks fall back at 03:00, so 02:30 happens twice: it fires once.
  const repeated = nextClockIn(['02:30', '09:00'], zone, at('2027-04-04T01:00:00+11:00'));
  assert.ok([at('2027-04-04T02:30:00+11:00'), at('2027-04-04T02:30:00+10:00')].includes(repeated));
  assert.equal(nextClockIn(['02:30', '09:00'], zone, repeated + 20_000, undefined, String(repeated)), at('2027-04-04T09:00:00+10:00'));
  assert.equal(nextClockIn([], zone, late), undefined);
});
