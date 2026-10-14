# bizencore terminal desktop

Electron reuses `desktop/main.tsx`, the existing Web App and the agent pane UI.
The Tauri prototype and its generated Rust/build caches have been removed.
Only the Electron build aliases Clerk imports to a compatibility adapter backed
by the official `@clerk/electron` SDK; the Web build keeps its original SDK.
Local builds do not publish the app or modify the Web deployment.

## Current product readiness

On 2026-10-12, the following implementations were integrated:

1. On macOS, closing the main window hides it without stopping agents. Dock
   activation restores it. Explicit Quit confirms active/pending agents,
   cancels pending launches and waits for process shutdown. Window bounds
   persist and are clamped to available displays on restoration.
2. Separate pinned preview and production profiles cover Clerk, Convex, MCP,
   callback schemes, storage, runtime and renderer builds. Production backend
   access requires a separate explicit enable flag and matching JWT issuer.
3. Production archives contain the app, a SHA-256 checksum and local artifact
   metadata. Apple Developer Program membership is not required. Packaging
   neither uploads nor publishes the app.
4. Updates are manual. The Developer ID/notarization pipeline, native automatic
   updater, update feed and related credentials have been removed.
5. Wake requests fresh authorization. Expired access stops agents/revokes MCP;
   restored panes remain idle and require explicit launch or resume.
6. Stopped panes can start a new conversation or explicitly resume an owned
   CLI session. Resume does not resend a handoff. A fresh task assignment clears
   the previous session selection. History is scoped by account, deployment,
   agent, working folder and CLI home; external CLI conversations are not
   silently imported. Unknown/ambiguous metadata fails closed.
7. CLI diagnostics check executable availability and bounded version output.
   Official installation/authentication guidance is available. Diagnostics
   never install software, request model work or claim CLI login was verified.
8. Account-scoped terminal font size, output search and HTTP(S) web links are
   available without restarting the PTY. Links cannot execute local/custom
   schemes or include URL credentials.
9. Task-completion notifications require explicit opt-in and a synchronized
   incomplete-to-complete transition for the same assigned task/pane. Native
   foreground suppression and rate limiting apply. Clicking restores/focuses
   that pane. CLI exit, restored completed tasks and output text are not proof
   of completion. Generic approval-wait detection is not implemented.

Development-native practical and task-tool verification is recorded below.
Those checks do not establish production authentication/sync or downloaded-app
installation on another Mac. No public desktop release has been performed.

## Production and release prerequisites

Create the ignored `.env.desktop-production.local` with the actual production
Clerk **publishable** key (`VITE_CLERK_PUBLISHABLE_KEY`, `pk_live_...`) and
`VITE_CONVEX_URL=https://good-chinchilla-15.convex.cloud`. Never include Clerk
secret keys or MCP shared secrets in renderer configuration.

After explicit authorization, configure the production Clerk Native API with
origin `bizencore-terminal://renderer`, callback
`bizencore-terminal://renderer/` and the existing Convex JWT template. Preserve
all existing allowlist entries. On the production Convex deployment, set
`DESKTOP_MCP_PRODUCTION_ENABLED=true` and
`DESKTOP_MCP_ISSUER=https://clerk.bizencore.com`; deploy the updated backend and
verify the JWT issuer configuration. Do not change development flags to obtain
production access.

```sh
npm run electron:production:check
npm run electron:production:build
```

The second command creates a local production candidate, not a public release.
Production account testing requires authorization. Preview and production
storage and backend destinations remain separate.

The chosen distribution policy does not use Apple Developer Program membership.
Production packaging applies an ad-hoc signature to seal resources and verifies
it with `codesign --verify --deep --strict`. This uses no certificate, signing
account or additional device entitlements. It is not a developer identity.
There is no Developer ID signature, notarization, Gatekeeper preapproval or
automatic update installation. macOS may block opening a downloaded copy; do
not disable system security or silently remove quarantine flags. The default
icon is `desktop/assets/icon.icns`; `DESKTOP_ICON_PATH` can select an absolute
`.icns`. Build arm64 first; `--arch=x64` requires separate verification.

```sh
npm run electron:release:check
npm run electron:release:build
```

Generated ZIP, `SHA256SUMS`, `artifact.json` and `INSTALL.md` are under
`out-electron/releases/production/darwin/<arch>/<version>/`. The metadata
records local ad-hoc signing, no Developer ID signature/notarization and manual updates.
The script never uploads files or changes macOS security settings. Verify
installation, production sign-in/sync/MCP, shutdown and sleep/wake before
publishing to the company website. Distribution hosting is a later decision;
no update service is required for a private production candidate.

## Build and run on Apple Silicon

```sh
npm install
npm run electron:build
open "out-electron/bizencore Electron Preview-darwin-arm64/bizencore Electron Preview.app"
```

The packaged app serves its renderer at
`bizencore-electron-preview://renderer/`, not `file://`. The package registers
this scheme with macOS; Clerk's main/preload bridge owns the OAuth round trip.
Opening renderer HTML in a browser is not a working desktop app.

The packaged preview uses a small bundled macOS AuthenticationServices helper
instead of an ordinary external-browser OAuth window. The OS authentication
session ends on its custom-scheme callback or cancellation. Token storage and
Clerk's nonce verification remain in the official SDK. No redirect allowlist or
production settings are changed. The helper is compiled using Xcode command line
tools. Its URL goes through stdin, its callback returns through a private pipe,
and neither is logged. Reload, app exit and renderer crash cancel pending auth.
This overrides one internal Clerk 0.0.52 transport channel; the runtime build
rejects other SDK versions until that integration is reviewed. The helper starts
explicitly on the main event loop, presents an anchor with a cancel action, and
reports only an OS error code on failure. Google sign-in and automatic window
dismissal were verified on this Mac on 2026-10-09. Authentication requests still
use the development instance.

For UI development, build the runtime, run `npm run electron:web` in one
terminal and `npm run electron:dev` in another. OAuth return must be tested
using the packaged `.app` on macOS.

## Development authentication setup

Preview builds deliberately reject production Clerk keys. The renderer and native
backend check use the same public Vite configuration from the existing
development environment. Secret keys are never included in app files.

The Clerk development instance must have Native API enabled. Its allowed
origins must include `bizencore-electron-preview://renderer` and, when using
the dev server, `http://127.0.0.1:5211`. The mobile SSO redirect allowlist must
include `bizencore-electron-preview://renderer/`. Preserve existing allowlist
entries when adding these; do not overwrite them with an example list.

Enabling Native API changes the instance's request pathway and bot protection.
Get explicit approval before changing even development settings. Do not modify
production settings for this preview.

Authentication uses Clerk's standard main-process storage adapter with Electron
OS encryption. Tokens are stored under the preview's user-data directory,
namespaced by development Clerk host. Plaintext fallback is disabled. When OS
encryption fails, tokens remain in memory and restart requires sign-in again.
Packaged macOS apps generally need a valid code-signing identity for Keychain
access; an unsigned preview must not be assumed to persist authentication.
Restored login state still needs fresh server authorization before any task UI
or agent pane is accessible. Logout invalidates the authenticated session;
Clerk may retain encrypted client state without an active session.

## Security and scope

- Only the authenticated, local main frame can list or start agents, choose a
  folder, send terminal input, or resize. Node integration is disabled; the
  renderer is sandboxed and context-isolated. Remote navigation, popups with
  native capabilities, webviews and renderer permission requests are blocked.
- Native authorization independently validates a Convex JWT with the pinned
  `accountDeletion:status` query. Decoding a JWT alone never grants access.
  Expiry, account changes and stale verification fail closed.
- Logout, renderer navigation/crash, auth expiry and approved app exit terminate
  agent processes. Hiding the macOS window does not. Sustained offline access
  is not supported.
- Only Claude Code or Codex may start, in a chosen existing directory, with
  at most eight sessions. Their own authentication and trust prompts remain.
- Pane-to-task assignments and account-scoped layout restoration are available.
  Running processes are not restored. Owned CLI conversations require explicit
  resume. Production account and downloaded-copy acceptance checks remain
  incomplete; the desktop app has not been publicly released.

## Task assignments

Each stopped pane can choose a label and then a task. The task inspector can
also assign its current task and consultation/execution intent to a stopped or
new pane. Assignment alone does not launch an agent. An explicit launch asks
for confirmation and passes the handoff as one positional CLI argument without
a shell, extra permissions or automatic terminal keystrokes. Running panes
cannot change assignments; one task cannot be assigned to two panes.

The assigned title and direct-subtask completion counts follow the shared task
store. A stopped or exited agent never marks a task complete; only synchronized
task data supplies completion status. Deleted, filed or completed assignments
cannot be launched again. Layout, assignments and work folders persist in local
storage, scoped by freshly verified account ID and backend URL. Account changes
never reuse another account's workspace. Restored panes are idle; explicit
launch constructs a new handoff from the current task store and reads the latest
MCP data. Explicitly selecting an owned CLI conversation instead resumes that
session without constructing or sending another task handoff.

Workspace snapshots contain no terminal output, prompt text, tokens, PIDs,
running status or previous send times. Corrupt/unsupported/oversized snapshots
fall back safely; duplicate pane/task IDs are normalized and restoration is
limited to eight panes. Folder selection still requires an existing directory
when launching. Storage is debounced during resizing and flushed on page hide
and workspace unmount. This is local layout persistence, not cloud synchronization
or automatic agent conversation recovery.

The preview now supplies its own development-only MCP to each native agent.
The user's global Codex and Claude Code configurations are not changed.
The user explicitly ruled out connecting the preview to their production
account on 2026-10-09. Do not switch to production to bypass a development gap.
The MCP-mode browser test uses fixtures only, not production credentials.

## Isolated development MCP

The build requires the existing development Clerk host and Convex deployment
`dazzling-setter-393`. Enable `DESKTOP_MCP_ENABLED=true` and set
`DESKTOP_MCP_ISSUER=https://grown-gorilla-52.clerk.accounts.dev` on **that dev
deployment only**, then run `npx convex dev --once`. Never use a production
deployment for these preview tests.

The main process serves shared MCP tools on a random loopback port. Each pane
receives an opaque bearer capability through its child environment, not command
arguments or config files. The verified Clerk JWT stays in main-process memory
and refreshes through the existing native authorization check. The backend's
`/desktop-mcp/*` routes derive the user from the verified JWT, ignore caller
account IDs, refuse deleting accounts, and require the pinned development
deployment/issuer plus the enable flag. Production `/mcp/*` shared-secret
authentication is unchanged. No Clerk secret or MCP shared secret is packaged.

Codex receives per-process MCP table replacements; all inherited servers are
disabled. Its effective configuration is checked before spawning and launch
fails closed unless the only enabled server is the loopback bizencore server.
Claude Code uses `--strict-mcp-config` with an environment-expanded bearer
header. These flags do not bypass either agent's workspace or tool approvals.
Stop, process exit, logout, account change, auth expiry and app exit revoke pane
capabilities. Pending launches also cancel when stopped or logged out.

On 2026-10-10, the development backend was deployed, actual installed Codex
configuration isolation was verified, and 167 unit tests plus the Electron
mock-auth and MCP/manual-handoff browser regressions passed. Web/MCP Apps and
the packaged Electron app build successfully.

On 2026-10-11, a real Codex task cycle passed in the packaged app on this Mac.
A dedicated development label, parent task, child task, context document and
completion criteria were created for the check. Label-then-task selection and
execution intent assigned the task without starting it. After explicit launch,
Codex read the latest task, attachment, child and criteria through development
MCP, then created `smoke-result.txt` in an empty temporary folder. An independent
read verified the exact 31 bytes: `bizencore desktop MCP cycle OK` plus one LF.
With one-time CLI approvals, `record_task_progress` completed the verified child
while leaving the parent incomplete; `complete_task` then completed the parent.
Both changes synchronized into the task list and pane status without refresh.
The idle agent was stopped after verification. No production account was
connected and no global CLI configuration was changed.

A separate real Claude Code cycle also passed on 2026-10-11. Development MCP
returned the current task, attachment, criteria and child. Claude Code wrote
`claude-smoke.txt`; an independent read verified its exact 30 bytes, containing
`bizencore Claude MCP cycle OK` plus one LF. `record_task_progress` completed
the child, and a fresh read confirmed the parent was still incomplete before
`complete_task` completed it. The app synchronized both checks and showed
`by agent · Claude Code`. This CLI used its existing auto approval mode; the
preview did not change approval settings or global configuration.

## Initial Multi-Agent Load Check

On 2026-10-11, one Claude Code and one Codex process were run concurrently in
dedicated temporary folders. Each generated and ran a bounded 60-second Node
job, emitting 600 SHA-256 tick records and verifying its result. Both result
files independently matched `{count:600,verified:true}`. The task inspector
opened and closed as a separate column while both processes continued. This
is a small synthetic workload, not a heavy project build, a high-throughput
terminal benchmark, or proof that eight active panes are responsive.

`measure-load.mjs` sampled only the packaged preview and its descendant
processes. App and agent/worker measurements are separate. The figures below
are process RSS sums, which can double-count shared pages; they are not physical
footprint and must not be compared directly with the earlier footprint probe.
CPU is the change in accumulated CPU time over each wall-clock interval;
100% represents one CPU core. Newly observed/exited process intervals are
excluded. UI inspection and resizing occurred during the active sample, and
other development tools also ran; these are exploratory samples, not isolated
performance benchmarks.

| Sample | App Mean RSS | Agent/Worker Mean RSS | App Mean CPU | Agent/Worker Mean CPU |
| --- | ---: | ---: | ---: | ---: |
| Two agents waiting, 10 s | 308 MiB | 386 MiB | 1.2% | 0.8% |
| Two bounded jobs, 90 s | 435 MiB | 500 MiB | 57.7% | 6.9% |
| After jobs, 10 s | 287 MiB | 320 MiB | 2.4% | 0.9% |

The active sample's app RSS peak was 540 MiB and agent/worker peak was 599 MiB;
these separate peaks need not occur simultaneously. App CPU peaked at 128%.
Returning near idle CPU is verified, but the elevated active rendering cost
needs profiling before declaring the eight-pane experience lightweight.
Four/eight active agents, sustained output, input latency and crash recovery
remain unverified. No production account was connected for either cycle or
the load check. The full unit suite, including two load-probe tests, passes
169 tests.

To repeat a read-only sample while the packaged preview is running:

```sh
node desktop/electron/measure-load.mjs two-agents-active 90 /private/tmp/bizencore-load.json
```

The optional output stores aggregate samples plus per-app-process PID,
executable basename, RSS and CPU counters. It contains no task contents,
terminal output, command arguments or environment variables.

## Output Flow Control And Scale Follow-Up (2026-10-11)

The renderer was the largest CPU consumer in a follow-up two-agent sample:
46.7% mean renderer CPU out of 63.7% app CPU. This locates the expensive process,
not a specific JavaScript function; the native stack sample lacked useful JS
symbols. Terminal output now batches for 8 ms, limits packets to 64 KiB and
allows one packet in flight until xterm's parsing callback acknowledges it.
Native PTYs pause at 256 KiB pending output and resume below 128 KiB. Stream IDs
reject stale acknowledgments after restarting a pane. Normal exit drains pending
output before the exit event; explicit stop/logout discard it. Repeated unchanged
terminal dimensions no longer trigger native resize calls.

The official xterm WebGL addon is allocated only on explicit agent launch and
released on stop/exit/failure. Idle/restored panes allocate no GPU renderer;
stopped panes keep their text through DOM rendering. DOM fallback also applies
when GPU rendering is unavailable or the rendering context is lost. Browser regressions exercise
split UTF-8/ANSI output acknowledgment and DOM fallback, including a run with
WebGL explicitly disabled. These browser tests use mock IPC/authentication, not
actual native agents.

An eight-native-PTY transport test independently verified all 12 MiB of known
Japanese/ANSI output byte-for-byte. Each PTY paused/resumed seven times, with
pending output capped at 256 KiB in this bounded fixture. This is a separate
transport test, not evidence of UI responsiveness under heavy agent work.

The updated packaged app also ran four real agents (two Claude Code, two Codex),
then eight (four of each), in separate temporary folders. Each ran a pre-existing
60-second Node script emitting and checking 600 hashes. All four and then all
eight result files independently matched `{count:600,verified:true}` with new
modification times. Real model requests were sent, not merely idle panes shown.
The central inspector and agent expansion were exercised without restarting
the sessions. Japanese paste/input and clearing were checked; native IME
conversion and quantitative keystroke latency remain unverified.

| Updated Sample | App Mean RSS | Agent/Worker Mean RSS | App Mean CPU | Agent/Worker Mean CPU |
| --- | ---: | ---: | ---: | ---: |
| Four bounded jobs, 90 s | 431 MiB | 953 MiB | 28.8% | 15.0% |
| Eight bounded jobs, 91 s | 395 MiB | 1675 MiB | 35.1% | 30.3% |
| Eight restored idle panes, 15 s | 499 MiB | 0 MiB | 1.3% | 0% |

App RSS peaks were 509/480 MiB; separate agent/worker peaks were 1166/1985 MiB.
Renderer CPU means were 11.2%/12.7%. Different pane dimensions, CLI output
strategies and inspection actions prevent a controlled before/after improvement
claim. CPU/RSS are exploratory process samples with the caveats above, not
physical memory footprint or guarantees for sustained heavy builds.

All eight agents were stopped and the app fully quit; no app/descendant processes
remained. Relaunch restored fresh development authorization, all eight agent
choices/folders and the adjusted task-column width (42%), with zero automatic
agent starts. Account isolation, assignment preservation and reload restoration
also pass the mock-auth browser regression. Legacy timestamp/random task IDs,
as well as UUID task IDs, are retained by workspace normalization and accepted
as bounded handoff data; native pane/stream IDs remain UUID-only. The full unit
suite passes 182 tests.

This historical checkpoint needed representative workloads, native input checks
and crash recovery. Later verification appears below; the current policy uses
manual distribution without Developer ID/notarization or an updater. An audit
reported 18 advisories (15 high, 2 moderate, 1 low). No advisory named the new
WebGL addon. Audit results require dependency-by-dependency triage; do not run
`npm audit fix --force` or silently downgrade major tooling to clear them.

## Verification

### Dependency Audit Follow-Up (2026-10-11)

Compatible-range updates in the lockfile reduced the full npm audit from
18 packages (15 high, 2 moderate, 1 low) to 3 high packages; the production-only
audit reports zero. Clerk Electron remains at the reviewed 0.0.52 transport
version. No production deployment or forced major update was performed.

Runtime paths were updated for Clerk shared/js-cookie, Convex/ws and React
Router. Build/lint paths were updated for Babel, browserslist and baseline
mapping, brace-expansion, js-yaml, PostCSS, nanoid, source-map-js and Vite.
Do not equate a dependency advisory with a confirmed exploit in this app.

The remaining three reports are the same build-only dependency chain:
vite-plugin-singlefile 2.3.3 -> micromatch 4.0.8 -> braces 3.0.3. The upstream
[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists no
patched version. Our single-file build explicitly supplies an empty inlinePattern;
the installed plugin guards both isMatch calls with inlinePattern.length.
No task data or other untrusted patterns are passed into that build config.
These packages are not bundled into the desktop main/preload/renderer runtime.
This limited build-time risk is accepted pending an upstream fix, not reported
as resolved or suppressed. A regression test preserves the empty-pattern guard.
Reassess before introducing pattern filtering or upgrading that plugin; do not
accept npm's suggested downgrade to singlefile 0.9.0 merely to clear the report.

After the updates, 183 unit tests, Web/MCP Apps builds, Electron runtime/package
builds and mock-auth/mock-IPC desktop browser regressions passed. The updated
packaged app restored development login with no automatically started agents.

```sh
npm test
npm run electron:ui
DESKTOP_RUNTIME=electron PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs PLAYWRIGHT_CHROME_CHANNEL=chrome node tests/desktopAuth.browser.mjs
```

The packaged executable accepts `--check-auth-storage` while the app is closed.
This verifies encryption, restoration using a fresh adapter, deletion and file
permissions using only a temporary dummy value, and prints booleans rather than
credentials. A passing adapter probe does not replace a real login/restart test.

The browser auth test mocks Clerk and native IPC. It does not prove real OAuth
or synchronized account data. `pty-smoke.mjs` can run with the packaged
Electron executable and `ELECTRON_RUN_AS_NODE=1`; it tests native PTY load,
Japanese byte output, resize and exit using `/bin/cat`, not an AI agent.

Initial local check on 2026-10-09: unsigned arm64 `.app` uses approximately
353 MiB on disk. A single idle sign-in screen with no agent running measured
about 152 MiB physical footprint across four app/helper processes. These are
not an eight-agent workload measurement or a like-for-like Tauri comparison.
Development authentication was verified on 2026-10-09: Native API was already
enabled, and the preview scheme redirect was added to the mobile SSO allowlist.
The instance was verified as `development`; its empty `allowed_origins` list
was updated with the preview scheme origin and `http://127.0.0.1:5211`.
Google sign-in opened in the system browser and returned to the packaged app.
After the user completed authentication, native Convex authorization succeeded
and the authenticated task list and agent workspace rendered. This uses the
development account data, not the production task list. Production settings
were not changed. The hidden label index's grid column was removed for desktop
only; a seeded-label browser regression test verifies usable task title width.
The rebuilt native app's authenticated task list was visually verified.

Native agent smoke check on the same day used an empty temporary directory:
Claude Code rendered its workspace trust prompt (not accepted), and Codex
rendered its interactive input screen. Japanese text was pasted into Codex and
cleared without submitting a request. Both processes were stopped through the
pane UI. No project work or model request was submitted during this check.
Cross-client edit synchronization, native IME composition, real agent work and
eight simultaneously running agents still require verification.

Encrypted storage check on 2026-10-09: the packaged unsigned preview passed the
local dummy-value probe on this Mac. Encryption on disk, restoration with a new
adapter, removal, absence of plaintext and 0600 file permissions were verified.
This result is machine-specific, not a guarantee for unsigned distribution. The
real development-account check also passed: after Google sign-in, the stored
entries were encrypted with 0600 permissions. Fully quitting and relaunching
restored login and fresh native Convex authorization without another sign-in.
Signing out immediately hid the workspace; quitting and relaunching again kept
the user signed out. Clerk retained encrypted client state, not a working login.
The preview was left on its sign-in screen after verification. All 155 unit
tests and the mocked Electron authentication browser checks pass.

Native follow-up on 2026-10-09: the AuthenticationServices flow returned to the
authenticated task list and agent workspace. The helper process exited, and the
user confirmed that the Google authentication window disappeared. Native UI
checks passed for label-then-task selection, assignment without launching an
agent, inspector assignment to an existing pane, consultation/execution intent
reflection, duplicate-task assignment rejection, folder-dialog cancellation,
eight idle panes and the disabled ninth-pane action. No model request was sent
and no task was completed during these checks. Eight idle panes are not an
eight-agent load test. The full suite now has 163 passing tests, including a
compiled Swift invalid-input lifecycle regression and sanitized OS failures.
After rebuilding with those final changes, a full quit/relaunch again restored
the authenticated development workspace without another sign-in. Pane count,
assignments and folders reset, as expected for the current in-memory design.

At this historical checkpoint, representative workloads, native input and crash
recovery still needed follow-up. Later checks appear below. Distribution now
uses a ZIP and manual replacement rather than a signed native update service.

Details-column follow-up on 2026-10-09: task and life-world inspectors now
render in an independent resizable column between the shared app and agent
panes. Closing restores the two-column layout without restarting terminals.
Narrow task columns use the existing details-only row controls so titles remain
readable. Browser tests with mocked IPC verify non-overlap at 900, 1380 and
1920 pixels, splitter resizing, initial title/estimate focus, life-world details,
running-terminal continuity and agent expansion. The regular Web life-world
regression and all 163 unit tests pass; Web inspector layout is unchanged.
After packaging, this Mac restored development authentication and visibly
rendered the three separate columns. Opening with Command-I, closing with
Escape and the close button, and returning focus to the original task were
verified natively. No real task was edited, completed or sent to an agent, and
production was not connected or deployed. Real Codex MCP progress was later
verified on 2026-10-11 as described above; native multi-agent load remains pending.

References: [Clerk encrypted storage](https://clerk.com/docs/reference/electron/storage),
[Clerk Electron quickstart](https://clerk.com/docs/electron/getting-started/quickstart),
[OAuth deep links](https://clerk.com/docs/guides/configure/auth-strategies/oauth-deep-links).

## Practical Verification Follow-Up (2026-10-11)

All checks used the development Clerk/Convex instances and dedicated temporary
project copies, never production data. `prepare-project-check.mjs` copies source
without .env or .git, shares dependencies read-only, and isolates build caches.
The original repository implementation was not changed by the agent workloads.
One Codex pane completed focused tests and a full Web/MCP Apps build; four
panes performed focused test edits/checks and builds. Three of the initial four
copies passed both; the fourth passed its build but its full suite encountered
sandbox restrictions on shared caches, loopback listening and the Swift cache.
The unrestricted repository suite passes, so that failed fixture run is not
reported as a successful full-suite agent run or as a product regression.

Representative project-load samples before the process-cleanup fix:

| Active CLI sessions | Window | App RSS mean/peak MiB | CLI/build RSS mean/peak MiB | App/CLI CPU mean |
| --- | --- | --- | --- | --- |
| 1 | 60 s | 386.5 / 430.6 | 306.6 / 642.1 | 14.48% / 20.19% |
| 4 | 90 s | 408.7 / 486.2 | 1354.2 / 2115.4 | 31.86% / 58.39% |
| 8 | 90 s | 386.9 / 503.3 | 3247.3 / 3778.4 | 49.64% / 177.88% |

These are process-RSS sums, not physical footprint; shared pages may be counted
twice. CPU 100% means one core and misses new/exited process intervals. Samples
were not clean-room benchmarks and include startup, waiting and build phases.
The four/eight stress prompts requested repeated full builds and were stopped;
do not describe those runs as eight completed builds. The host already had
substantial swap pressure. Reports are in /private/tmp/bizencore-project-*-load.json.

Stopping revealed detached build jobs outside the app's descendant tree. The
new process guardian tracks PID, creation time and executable, including known
reparented descendants. Stop revokes pane access immediately and freezes/rescans
the owned tree before killing it. The independent guardian also reaps on CLI
exit or parent IPC disconnect. Its packaged worker lives outside app.asar.
Actual macOS process tests with detached SIGHUP-ignoring workers passed normal
stop, CLI SIGKILL and owner SIGKILL, with zero remaining workers, using both
Node and the packaged Electron runtime. This is bounded process-tree coverage,
not a guarantee against arbitrary daemonization between polling intervals.

After packaging, the real app's renderer was killed with Codex running. Codex
stopped, the recovery dialog appeared, and Reload restored the authenticated
development task UI and eight idle panes. Killing the app main process also
removed Codex and the guardian; relaunch restored authentication and idle panes.
The task counter remained 18; crashes did not mark tasks complete. Assignments
were not changed by these stress checks; assignment restoration has separate
workspace-state and earlier native coverage.

The final eight-pane check (four Claude Code, four Codex) ran focused tests once
per copy: 7/7/7/7/5/5/6/5 tests, all zero failures and exit code 0. Logs and exit
codes were read independently from each phase-final-* file. A following 30-second
sample retained eight CLI sessions: app RSS mean/peak 538.3/568.5 MiB and CLI RSS
1790.2/1896.1 MiB; CPU means 2.62%/6.38%. Most test work had already finished,
so this is a light/waiting sample, not evidence of an improvement over stress.
All eight were stopped through the native UI. Captured process identities and
an independent test-folder cwd scan both showed zero residual jobs. Evidence:
/private/tmp/bizencore-guarded-eight-focused-load.json and each dedicated
/private/tmp/bizencore-scale-*/project-check/phase-final-{tests.log,result.json}.

Eight native PTYs delivered 12 MiB of Japanese/ANSI output with exact hashes,
bounded queues and real pause/resume. This verifies transport, not UI paint.
All 194 repository unit tests pass. Native ASCII input observations had no lost
keys, but dispatch-to-accessibility timings include automation overhead and are
not key-to-paint latency. Native IME composition/confirmation/cancellation,
quantitative input latency, and real offline/expired-auth recovery remain open.
Mocked authorization expiry/account-isolation checks do not replace those
native checks. Desktop practical acceptance is therefore still incomplete;
no production connection, deployment or signed release was performed.

Native IME manual follow-up (2026-10-11): with Claude Code and Codex running
but waiting for input, the user checked the task search field and both CLI
prompts. Conversion/confirmation of Japanese text, cursor editing and Escape
cancellation were reported as all working, without missing/duplicate text or
unintended submission. This is user-verified native input, not pasted text or
automated composition. It does not establish quantitative key-to-paint latency
or IME behavior during heavy active multi-agent workloads; those remain open,
as do real offline/expired-auth recovery checks.

### Native Input Measurements

Follow-up on 2026-10-11 used the same 16 GiB, eight-logical-core Mac and two
idle CLI sessions. The opt-in `--validate-runtime` mode is restricted to the
pinned development Clerk/Convex pair. It records timestamps and durations in a
private 0600 JSONL report, not keystrokes, terminal content, account IDs or tokens.
No model request was sent. Ordinary app runs expose no validation bridge/menu.

Each cohort used 20 alphabetic native key events, about 0.5 s apart. Electron's
Event Timing measures key processing through the next rendering update, rounded
to 8 ms; entries below the 16 ms observation threshold are censored, not zero.
The p95 values below include all 20 events with censored entries treated as
upper bounds. Terminal echo separately measures the trusted key timestamp to a
changed xterm viewport followed by two animation frames. This includes PTY/TUI
latency and frame waiting; it is a conservative rendered-echo estimate, not a
physical display measurement. It is valid here because the CLIs were idle, not
streaming unrelated output. Automation round-trip and AX polling are excluded.

| Load | Surface | Key-to-next-paint p95 upper bound / max | Terminal echo p50 / p95 / max |
| --- | --- | --- | --- |
| Normal | Task search | 48 / 96 ms | n/a |
| Normal | Claude Code | <16 / 56 ms | 46.1 / 63.7 / 97.0 ms |
| Normal | Codex | <16 / 32 ms | 62.7 / 79.7 / 112.0 ms |
| CPU saturation | Task search | 48 / 56 ms | n/a |
| CPU saturation | Claude Code | <16 / 64 ms | 47.4 / 68.6 / 89.0 ms |
| CPU saturation | Codex | <16 / 24 ms | 68.3 / 106.5 / 144.7 ms |

`input-load.mjs` supplied eight bounded CPU workers, measured around 520-630%
CPU and 84-92 MiB RSS. It is CPU saturation, not eight simultaneous AI builds.
A concurrent 60 s sample kept both CLIs running throughout: app RSS mean/peak
441.95/472.52 MiB, CPU mean/peak 10.35/30.92%; CLI RSS 311.58/337.52 MiB and CPU
1.35/8.52%. Worker load is separate from both groups. Shared RSS pages can be
counted twice; CPU 100% means one core. All load workers exited after the test.
Evidence: /private/tmp/bizencore-input-saturation-load.json and the private
bizencore-runtime-validation-znDFNa/report.jsonl in the macOS temporary folder.

No lost/duplicate ASCII characters or unintended request submission were seen.
Under CPU saturation, native Japanese conversion, confirmation, cursor/backspace
editing and Escape cancellation were checked in task search, Claude Code and
Codex. Normal-load physical keyboard input was previously verified by the user.
Automated Return had native IME conversion quirks; keypad Enter confirmed the
candidate without submitting a CLI request. Screenshots, not stale terminal AX
textarea values, verified the actual TUI text. This does not prove every IME
variant or physical keyboard binding. The small cohorts indicate usable input
on this Mac, with worst observed ASCII echo below 145 ms, not a pre-agreed
100 ms SLA or a cross-device latency guarantee.

References: [Event Timing](https://www.w3.org/TR/event-timing/),
[Electron session networking](https://www.electronjs.org/docs/latest/api/session).

### Repeating Network And Authorization Checks

Quit before rebuilding, then launch the packaged development app with
`open -a '<app path>' --args --validate-runtime`. The development-only validation
menu can hold a disposable loopback capability and probe its MCP `initialize`
HTTP status without reading private tasks or sending an AI request. Offline
injection cancels remote HTTP(S)/WS(S) in that Electron session; local packaged
assets and loopback probes remain available. It does not change the Mac network
settings or isolate separate agent processes from their own model providers.
This tests losing the app's Clerk/Convex connectivity, not a physical adapter
failure or every operating-system network stack.

Electron network emulation alone did not block native authorization in the
first attempted run. That attempt was rejected as evidence. The final request
handler records cancellation metadata without URLs or credentials. Authorization
and desktop MCP cloud transport use Electron's network stack, while the local
status-only probe uses Node fetch. The separate refresh-pause switch skips only
renewal after a real server grant; initial authorization cannot be skipped.
Neither fault switch extends a grant, forges a JWT or changes the clock. Both
defaults are off, exist only in this explicit development mode, and reset when
the app exits. Native authorization expires at the earlier of the verified JWT
expiry and its existing 90-second lease; checks use wall and monotonic clocks.
These tests do not revoke a Clerk account/session on the server. Server-side
revocation, cross-device propagation and signed production authentication need
their own release-environment acceptance checks.

Native outcomes on 2026-10-11:

- Connectivity loss: remote Clerk requests were cancelled. Renewal stopped;
  the last real grant expired at 1791698454000 ms and the watchdog locked the
  app at 1791698454445 ms. Both running CLIs exited. The task/agent workspace
  disappeared and the reload/sign-out screen appeared. The held MCP capability
  changed from HTTP 200 to 401, with zero running/pending/stopping panes. Captured
  CLI PID/start-time/executable identities had zero remaining matches.
- Connectivity restoration: offline injection was disabled and Reload obtained
  fresh authorization, generation 4. The 18-task list and two saved folders/
  pane layouts returned with both CLIs idle. The old capability still returned
  401 despite the new authorized session. Explicitly starting both CLIs worked.
- Expiry with connectivity intact: renewal was paused only after a real server
  grant. The grant expired at 1791698616000 ms; the watchdog fired at
  1791698616634 ms without clock/JWT manipulation. Both CLI processes stopped,
  the authentication gate replaced the workspace, and the held capability
  returned 401 with no running/pending/stopping sessions or matched CLI residue.
- Renewal restoration: the pause switch was disabled and Reload obtained a
  fresh grant, generation 7. The old capability stayed at 401 while native access
  was authorized, and both restored panes remained idle. A final full quit and
  relaunch without validation arguments restored the authenticated development
  workspace with no validation menu, fault injection or automatically started CLI.

Evidence: bizencore-runtime-validation-akby3u/report.jsonl in the macOS temporary
folder. The expiry covered the native verified-session lease, not a revoked
Clerk server session. No task was completed by CLI exit/crash/expiry; the
development task counter remained 18. The 200-unit-test suite and isolated
authentication/layout browser regressions also pass; mocked results are separate
from the native outcomes above. These native checks complete the previously
open local practical-verification scope on this Mac, not signed distribution,
production migration or acceptance across other hardware/OS/IME variants.

## Integrated macOS Title Bar

The macOS Electron window uses `hiddenInset` with native traffic-light controls
positioned at (16, 20). The window controls and shared header occupy one 56 px
row, replacing the former 40 px drag strip plus 64 px app header. A 96 px left
inset reserves space for the native controls. Empty header space is draggable;
navigation, account and settings controls explicitly opt out of dragging.
The authentication header uses the same compact row. A fallback drag strip
remains only for content without either header. The Web app is unchanged;
other desktop runtimes do not reserve renderer space for macOS controls.
The read-only preload flag adds no IPC capability or permission.

On 2026-10-11, the rebuilt Mac app restored development login and idle panes,
visibly rendered the continuous black surface and retained the native close,
minimize and full-screen controls. Isolated browser checks passed all three
themes, signed-out/loading/expired auth screens and the three-width inspector
layout; all 200 unit tests and the Electron UI build passed. No production
connection, deployment or signed release was performed.

## Configure Before Launch

With no agents, the right region becomes a 56 px rail containing the add
action. Adding opens a setup form, not an empty terminal: select Claude Code or
Codex, an existing working directory, and optionally a label/task plus
consultation or execution intent. Only explicit launch creates a pane and PTY.
Inspector handoff to a new pane opens the same prefilled setup form.

Restored, unstarted panes retain compact headers and assignments without blank
terminal areas. Grid, numbered tabs, individual zoom and reorder controls keep
the same React/xterm instances mounted; hiding a pane does not stop its CLI.
Tab arrows/Home/End navigate without intercepting terminal keyboard input.
Assigned task titles open the independent middle inspector column; closing it
returns keyboard focus to the originating pane control. Layout mode persists
per account/environment, but launch requests never persist or restore.

At that earlier checkpoint, isolated Electron text/MCP and legacy Tauri bridge
browser regressions covered setup,
zero-pane collapse, ordering, zoom, live terminal continuity, focus return and
the eight-pane cap. Authentication/account/reload checks and 201 unit tests
pass. Native macOS checks launched both installed CLIs without model requests
and verified the compact rail, configuration, tabs, ordering and individual
zoom in the development environment. No production account was connected.

## Shared Workspace Header

The Web App's existing brand/navigation/settings/account header is portaled
to one full-width 56 px desktop header above the workspace columns. It stays visible
when the task column scrolls or agents are expanded; global navigation returns
to the task column. Task, detail and agent toolbars share a 54 px row beneath
it. No header or agent process is duplicated to achieve this layout.

Docked task and life details use the exact workspace background for all three
themes, with no overlay shadow. Their header/close action stays fixed while
the content scrolls independently. Web/MCP Apps overlay details keep their
existing background and structure. Browser checks cover all theme backgrounds,
toolbar alignment, scroll behavior, navigation and terminal continuity.

## Terminal Themes

The agent toolbar, launcher and panes inherit the selected workspace theme.
Xterm uses the same page background, primary text and accent cursor, with
separate light/dark ANSI palettes and a 4.5 minimum text contrast ratio for
CLI-supplied colors. A theme observer updates each terminal's renderer in
place, including hidden tabs; it never restarts the PTY or clears scrollback.
Browser checks exercise live theme switching with selections and ANSI/truecolor
output in WebGL and DOM fallback renderers, plus hidden panes. CLI-controlled
explicit background colors remain part of the terminal output.

## Task Tools Native Verification (2026-10-12)

These checks used the packaged Electron Preview, the development Clerk/Convex
profile, and `/private/tmp/bizencore-task-tools-demo-2026-10-12`. No production
account, publication, message, reservation or payment was involved.

- Claude Code created `codex-greeting.txt`, read it back, updated one existing
  progress document and completed the selected task through development MCP.
  A separate byte-level assertion verified the exact 34-byte output including LF.
- The color sample returned a focused question without creating an output or
  checking the task. A synthetic test answer `blue` resumed it; Read/Write and
  MCP completion succeeded. A separate assertion verified exactly `blue\n`.
- Read-only Claude decomposition returned six AI/human/joint steps, reusing the
  existing agenda child. Explicit application added five children and one
  allocation document. A second read through development MCP saw all six
  children; its proposal reused every child. Reapplication kept six children
  and one document, with the parent and children still incomplete. Planning
  did not write any reading-group output files.
- Codex created `claude-checklist.md`, read it back and completed the selected
  task through development MCP. An independent assertion verified its exact
  65 bytes. The user approved per-run selected-subtree tool permissions only,
  with planning reads only. Transport and permissions share one complete
  override, passed inside `exec` rather than before that subcommand. Cloud Apps
  are disabled for isolated launches: otherwise the CLI can select the user's
  same-named cloud connector rather than the development loopback tools.
- A fresh two-task, cross-label queue ran Claude Code followed by Codex from
  one start confirmation, with no intervention between tasks. Both completed
  through development MCP, and their exact output bytes were checked again.
  Claude updated its existing progress document rather than creating another.

Compatibility fixes include draft-07 structured result schemas for Claude and
explicit permissions for the existing scoped MCP tools. Claude shell commands
are not automatically approved; commands requiring additional permission must
produce a question rather than a broad permission bypass. Permissions remain
checked at the per-run loopback capability and selected task subtree.

The mocked-native-IPC browser regression passes, separately from the real CLI
checks above. All 306 unit/transport tests, focused lint and config dry-runs
also pass; they are recorded independently of the native CLI outcomes. Early
macOS quit checks found a preview process still alive, and restarts used
user-authorized force quit. MCP shutdown and deferred approved-quit dispatch
are now present. Fresh checks verified normal quit both after login and after
another real Codex task cycle: window close, will-quit and quit events all
occurred, and the exact main PID and its children were absent. Temporary event
tracing was removed from the final build; that packaged build also restored
login and exited via Command-Q with its exact PID and children absent. These bounded checks do not replace
production-installation acceptance or long-running lifecycle testing on other machines.

## Manual Production Candidate (2026-10-13)

The user chose distribution without Apple Developer Program membership. The
Developer ID/notary credentials, signing/stapling/Gatekeeper preflight pipeline,
native auto-updater and its tests were removed. Production archives now record
manual updates and explicitly disclose no Developer ID signature/notarization.
The revised 301-test suite, focused lint and production preflight passed.

The actual production publishable key was read from Clerk's production API-key
page and saved only with the public Convex URL in ignored
`.env.desktop-production.local`. No secret key was added. A local Apple Silicon
production candidate was built under `out-electron/bizencore terminal-darwin-arm64`.
Preview identity/storage/backend were not switched or migrated.

With explicit user permission, Clerk production's existing Native API remained
enabled, `bizencore-terminal://renderer` was added to allowed origins and
`bizencore-terminal://renderer/` to the SSO redirect allowlist. CLI readback and
the dashboard row confirmed the saved values. The user completed Google sign-in
and separately authorized production desktop MCP. The production deployment now
has `DESKTOP_MCP_PRODUCTION_ENABLED=true` and the pinned production issuer.
The backend was deployed; anonymous requests and malformed JWTs both return 401
without data access. A regression covers rejected JWT identity lookup.

In the packaged production candidate, two dedicated sample leaves were explicitly
assigned to Codex and Claude Code and executed sequentially in an empty temporary
folder. Both read their latest task through the isolated desktop MCP, created a
file, recorded progress and completed only their selected leaf. Independent byte
comparison verified `codex-production.txt` (34 bytes) and
`claude-production.txt` (35 bytes), including one trailing LF. Production task
readback identifies the completing clients as Codex and Claude Code, and the
candidate shows both completed. Existing work tasks were not executed. After
normal quit and rebuild/restart, production login and task state were restored
with no automatic agent launches.

A local arm64 0.1.0 ZIP, `SHA256SUMS` and `artifact.json` were generated and their
hash and size independently compared. No files were uploaded. This is not proof
that a downloaded/quarantined copy opens on another Mac. Browser production sync
acceptance, production logout/re-login/revocation acceptance and downloaded-copy
installation/manual replacement remain separate checks. The full 301-test suite
passes. There was no Web frontend deployment or public desktop release.

## Downloaded-copy acceptance (2026-10-13)

Safari downloaded 0.1.0 through a temporary loopback-only server and automatically
extracted the ZIP. The resulting app retained `com.apple.quarantine` with Safari
as the download agent. It was moved, without clearing that attribute, into
`~/Applications/bizencore terminal.app`. macOS reported the app was damaged and
refused to open it. Independent signature inspection found only the linker's
ad-hoc executable signature, no sealed resources and no bound Info.plist;
`codesign --verify --deep --strict` failed with "code has no resources but
signature indicates they must be present". The attempted process stayed at
`_dyld_start` rather than creating the workspace. Local-build startup had not
caught this packaging defect.

Production packaging now uses the existing official Electron signing helper to
apply a certificate-free ad-hoc resource seal. It never searches for a Developer
ID certificate, creates a Team ID or notarizes the bundle. No new device
entitlements are added; the prior non-hardened-runtime configuration is retained.
Strict verification is required before creating an archive. The artifact records
`adHocSigned: true`, `developerIdSigned: false`, `notarized: false` and manual
updates. The 0.1.2 archive and checksum match, and its Safari-downloaded copy
retains quarantine and passes strict signature verification. Its title follows
the production profile rather than showing "Electron Preview".

With 0.1.2, macOS no longer reports damaged; it instead refuses to open because
Apple could not verify freedom from malware. This is not a successful first
launch, and a valid ad-hoc signature is not Gatekeeper approval. Per-app approval
was handed to the user. No Gatekeeper setting or quarantine attribute was
disabled, and no app was moved to the Bin. The installed path now contains 0.1.2;
the old 0.1.0 copy is retained under `/private/tmp/bizencore-install-backups/0.1.0`,
and its original ZIP remains in the release directory. Update/rollback startup,
production logout/re-login and installed-copy agent operation remain pending.

The user had filed/deleted the earlier completed smoke leaves before browser
acceptance. They were not recreated or restored. The production browser is now
signed in and reads the current list, but the old completed-leaf display cannot
be asserted. The full 302-test suite and focused lint pass. Nothing was published.

## Installed Update and Rollback (2026-10-13)

The user personally approved 0.1.2 in macOS Privacy & Security. Its installed,
Safari-quarantined copy launched under App Translocation, restored the production
account and did not auto-start agents. New acceptance leaves, not the previously
deleted leaves, were assigned to the actual Codex and Claude Code CLIs. Independent
byte comparison verified `codex-installed.txt` (33 bytes) and
`claude-installed.txt` (34 bytes). Production MCP identified each completing
client, and the production Web UI showed both completed.

Cancelling Command-Q during a task operation exposed a lifecycle defect: a stale
pending-launch guard incorrectly rejected an already running operation's result.
The operation guard now enforces pending-launch validity only until spawn, while
continuously enforcing account generation and abort state. Pending launches still
invalidate on cancellation; authentication expiry and explicit stop still reject
running operations. A regression test covers these distinct cases.

Safari downloaded 0.1.4, its archive hash/size and quarantined bundle's deep/strict
resource seal passed verification, and the stopped 0.1.2 app was retained before
replacement. The user personally approved the new build; approval of one build
did not approve the update. The native menu showed version 0.1.4 and manual update,
checksum, safe replacement and rollback instructions. Login, tasks, remembered
work folder and the deliberately changed font size survived the update. A real
started Codex operation continued after cancelling Command-Q, verified its exact
25-byte `quit-cancel-result.txt`, and waited for operator evidence about the OS
dialog. After that evidence was supplied through the native reply UI, the resumed
operation completed the selected leaf through production MCP without a false
error. The CLI was not claimed to have observed the OS dialog itself.

Normal quit followed by rollback to the previously approved 0.1.2 and return to
0.1.4 preserved login, tasks and font size, without automatic agent launches or
additional approval for those already approved copies. The temporary font change
was restored to 13. Production logout showed only sign-in, with no task or native
agent controls. Google re-login restored the same account and tasks; the auth
helper closed and the font preference remained 13.

All 303 unit/transport tests, focused lint and diff whitespace checks passed.
Installation and rollback were tested on this Apple Silicon Mac only. Public
distribution, separate-account production acceptance and actual server-side
session revocation remain unverified. Missing-CLI/permission-denial handling has
unit/development evidence but was not re-created in the installed production
candidate; the existing globally installed CLIs were not removed to simulate it.
No Gatekeeper setting or quarantine attribute was cleared. No files were uploaded,
no Web frontend was deployed, and no public desktop release was made. The
loopback-only download server was stopped. The installed private candidate is
0.1.4; older defective 0.1.0/0.1.1 archives must not be distributed.

## Interactive Orchestration (2026-10-13)

The execute path no longer uses the headless structured-result runner. The
desktop calls it orchestration and opens one dedicated, interactive xterm/PTY
session per current task, switching providers sequentially without repurposing
manual panes. It reads the latest task natively before issuing a capability
limited to that task's existing subtree. Task context, permission prompts,
questions and output remain visible in the normal Codex/Claude Code UI. User
typing goes directly to the CLI. Decomposition remains a distinct, read-only
structured-result operation.

The default is manual progression. The native process re-reads the assigned
task, confirms its latest MCP state, and asks before stopping that session and
advancing. Incomplete work can advance only through explicit confirmation and
is recorded as incomplete. Optional automatic progression requires the entire
unlocked subtree to be complete in MCP; neither output nor exit code qualifies.
Human key/paste/IME input holds auto progression, while terminal protocol
responses do not. The user may explicitly resume automatic progression.
Shutdown, natural exit and duplicate stop requests share a process-tree barrier.
Pending startup is aborted and retains its reservation until probes have exited.
Failed cleanup prevents another launch. Account-generation checks, scoped MCP,
revocation and no-auto-start restoration remain enforced.

The development-native check selected two fresh dedicated sample leaves only:
Codex `203d3895-4f7a-4257-bce3-f2313a423320` and Claude Code
`d3aeaecb-fcfb-48c2-bdce-9c52348a0737`. Both normal CLIs read development MCP,
created their respective file and completed only their assigned leaf. Independent
byte comparison in `/private/tmp/bizencore-interactive-2026-10-13` verified
`codex-interactive.txt` (31 bytes) and `claude-interactive.txt` (32 bytes).
Codex remained interactive after completion and answered an additional typed
question without more changes. Native MCP review confirmed completion before
manual provider switching and final session termination. The terminal-only
font setting changed live from 13 to 15 and was restored to 13; the browser
regression separately measured row-height changes from 13 to 18 without relaunch.

The browser regression uses mock native IPC and real xterm, independently of
the native evidence above. It covers visible output, typing, manual/automatic
progression, human-input hold/resume, verified completion, pause/stop/recovery,
decomposition/document reuse, and narrow layout. All 315 unit/transport tests
and focused lint pass. A read-only second review found startup/shutdown races;
the fixes have dedicated barrier and real SIGTERM-resistant probe tests. These
changes are in the development build, not installed production candidate 0.1.4.
The development app was restarted through targeted SIGTERM after both agents
had stopped; CUA-issued Quit did not establish main-process exit, so this run
does not count as a passing normal-quit regression. No production data or
public Web/desktop deployment was changed for these execution checks.

The final-build native automatic-progression check used two fresh read-only
fixtures: Codex `1339aa7c-5711-465f-9712-4a74e0ae0466`, then Claude Code
`a16ab451-f732-45e8-aecf-6294216bc367`. The initial Codex request returned 429 and
was explicitly stopped without completion. A subsequent run exposed that xterm
consumes Enter before bubbling, so the human-input listeners were moved to the
capture phase and a real-xterm Enter regression was added. After rebuilding,
Codex's one-call MCP permission approval visibly held automatic progression.
Its task reached `done: true`, but the CLI stayed open until explicit resume.
Native MCP review then stopped Codex and automatically launched Claude Code,
without the manual-next button. Claude read and hex-checked its existing file,
recorded completion, and the final MCP review stopped its CLI automatically.
Both results showed MCP-confirmed completion and the agent count returned to 0.
Independent byte comparison still matched the original 31/32-byte files exactly.
No global CLI permissions were changed; Claude's existing auto-mode setting was
not enabled by this check. All 315 tests, focused lint, the browser regression
and the development package build passed after the capture-phase fix. The
installed production candidate remains 0.1.4, unchanged and unpublished.

## Production Candidate 0.1.5 (2026-10-14)

The interactive-orchestration changes, capture-phase input hold and shared
terminal font-size preference are now included in a production-profile arm64
0.1.5 manual-distribution archive. The setting is named terminal font size and
shows a stable-width pixel value; it is independent of whole-window zoom.
The workspace browser fixture now tracks manual-pane terminals specifically,
so mounting a separate orchestration terminal cannot misdirect the font/search
assertions. Both real-xterm/mock-IPC browser suites, 315 unit/transport tests,
focused orchestration/test lint and production packaging pass.

Safari downloaded and extracted the archive from a temporary loopback-only
server, which was then stopped. The downloaded bundle passed codesign
deep/strict verification and its app.asar SHA-256 matches the generated bundle.
The stopped installed 0.1.4 was moved to
`out-electron/install-backups/0.1.4-before-0.1.5-2026-10-14/bizencore terminal.app`,
and the downloaded 0.1.5 now occupies the original per-user Applications path.
Account storage was not removed or rewritten, and Safari quarantine is retained.
The user completed candidate-specific Open Anyway and the final Open/authentication
steps; no OS protection or quarantine attribute was disabled. macOS runs the
downloaded copy in App Translocation. Initial CUA frame/screenshot acquisition
was inconsistent with the accessibility state; reload did not establish recovery.
With no agents running, that instance was ended through targeted SIGTERM and
restarted. Do not count that initial attempt as a successful normal-quit check.

The installed 0.1.5 then restored the production account and task list with zero
agents. An unassigned Codex pane remained open while its font changed 13 to 18
pixels; native screenshots verified larger terminal text without larger workspace
UI. The same preference applied live to the dedicated orchestration terminal,
which was changed back to 13 during execution without relaunching its CLI.
Only two fresh production samples were executed: Codex
`2fc5a9e0-b13e-47d2-bea7-014564d4a697`, then Claude Code
`b109fc8c-229d-4506-8cb9-c62902b516cd`. Both read their latest task through the
production desktop MCP and independently checked the dedicated existing files.
One-call Codex permission approval held automatic progression. MCP completion
did not stop its CLI while held, and a typed follow-up was answered without more
changes. Explicit resume led to native MCP review, Codex shutdown and automatic
Claude Code startup. The latter's initial trust prompt was accepted only for the
self-created fixture folder, holding progression again. Explicit resume after
its MCP completion stopped the final CLI and left both results completed.
Independent byte comparison confirmed the original 44/45-byte files unchanged,
and MCP get_task confirmed each provider's completed_by_client.

After this completed run, Command-Q exited the app and its translocated children
(verified through the process list). A normal relaunch preserved the account,
both completed queue results and a deliberately selected 18-pixel preference,
without launching agents. The font was restored to the user's prior 13 pixels.
Native screenshots are in `/private/tmp/bizencore-015-font-13.png`,
`/private/tmp/bizencore-015-font-18.png`,
`/private/tmp/bizencore-015-orchestration-complete.png` and
`/private/tmp/bizencore-015-after-restart.png`.
No existing real task was executed or completed. No public Web or desktop
deployment was made. Separate-account/server-revocation acceptance and the other
previously recorded product-wide release limitations remain open.

## Web Task Feature Parity (2026-10-14)

Desktop retains the shared Web task page rather than hiding its label index.
The index uses a left column when the task container exceeds 760 px and a
horizontal sticky row below the view toolbar otherwise. The breakpoint follows
the task column, not the overall window width, so opening agents or the center
inspector does not remove task navigation or narrow task titles unnecessarily.

The shared page detects its actual scroll ancestor, tracks that ancestor's scroll
position and size, and compares anchors using the same scroll-margin landing
offset as label navigation. This avoids window-only scroll tracking, stale
current-label highlights and fractional-position drift. Web window scrolling
remains supported. The All label index includes Life World when shown there.

`tests/taskFeatureParity.browser.mjs` verifies both Web and desktop rendering:
label jumps, settled current-label tracking, manual top/end scrolling, nested
scroll isolation, column resizing, independent center details, focus shortcuts,
All/Board/Today, search-to-row/details and Life World filing/deletion. It uses
mock IPC and disposable browser data, never a real account or CLI agent.
The final 329-test suite, focused lint, desktop workspace browser regression,
mock-auth boundary regression and Electron builds passed. The preview's native
login and label-index display/jump were checked; no real task state was edited.

The private 0.1.6 update candidate incorporates the current shared Web features.
It is ad-hoc signed, not Developer ID signed or notarized. The earlier unpublished
0.1.6 candidate is preserved under `out-electron/unpublished-candidates/` and must
not be used instead of the final build. The installed production candidate 0.1.5
has not been replaced: replacement requires the user's explicit approval, and
candidate-specific macOS approval may be required. No public release or Web
deployment was performed for this parity task.

## Task Context Drops And Candidate 0.1.7 (2026-10-14)

The shared task page accepts HTTP/HTTPS links and multiple files dropped onto an
ordinary task, subtask or locked container. Drops use the existing context model
and authenticated upload endpoint; they never replace the task title or note.
The file chooser and row drops share sequential uploads, 10 MB/50 attachment
limits and account/task/unmount guards. Links are deduplicated; partial failures
remain visible. Folders and non-Web URLs are not accepted. Life World has a
separate model without context attachments and is not a drop target.

`tests/taskContextDrop.browser.mjs` and `tests/taskFiles.browser.mjs` verify these
flows with disposable browser data and isolated authentication/storage mocks.
The root suite passed 334 tests; the Web-only release passed 162 tests. Web
commit `850c0e1` is published at `https://app.bizencore.com/`; the deployment is
Ready and the production bundle contains the drop handlers. Anonymous upload
and MCP requests still receive 401. No real task data was changed for these tests.

Private candidate 0.1.7 includes both the label-index fix and context drops.
Its build and strict/deep ad-hoc signature checks passed. It supersedes 0.1.6
for the next installation but is not publicly distributed, Developer ID signed
or notarized. Installed 0.1.5 and its login storage remain unchanged; explicit
permission to replace it and final installed-app checks are still pending.
