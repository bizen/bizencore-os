# App Update Detection

The main Vite build generates a UUID shared by the compiled application and
`dist/version.json`. The public version file is not cached. The app checks on
startup, return to the foreground, reconnection, and every three minutes while
visible. Repeated lifecycle events are throttled; requests time out after ten
seconds. Development mode disables these checks.

Only a valid, different build ID shows the header refresh icon. Failed requests
and rollbacks to the current build clear it. Nothing reloads automatically.
Clicking checks the published version again, commits blur-based inputs, saves
current task/life/count data locally, then reloads. Storage failures and active
uploads block reload; unattached context text requires confirmation. Local
task and life snapshots are merged with other tabs' persisted edits first.
Cloud synchronization resumes after reload; local save is not a cloud-sync
guarantee. No service worker or notification permission is involved.

This only detects frontend releases. Task changes arrive through the existing
sync subscriptions. A backend-only release cannot trigger the indicator.
The first release adding this feature still requires a manual reload of an
already-open older app, since that old app has no version checker.

Focused checks:

```sh
npm test
PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs node tests/appUpdate.browser.mjs
```

Use `PLAYWRIGHT_CHROME_CHANNEL=chrome` for installed Chrome. The browser test
uses synthetic tasks and simulated releases, not real accounts or production.
