# Desktop Release Readiness

## Private 0.1.15 Installed Acceptance (2026-10-16)

- Built from clean source `b940ad6e6c47ae7a7c77c1e099fd5f6f563db2bd`, local tag
  `desktop-v0.1.15-candidate.1`, renderer/native build ID
  `fb177914-02c1-47d5-b64e-50863a965718`. The 147015541-byte ZIP has SHA-256
  `9a95c2ca1b954cd1d941274e4ead6c23f9b492ee46bbd38849d3ba99fc0cc277`.
  The extracted archive passed deep/strict ad-hoc signature, pinned production
  profile/build metadata, notice and excluded-artwork checks before installation.
- Installed at the existing stable app path and preserved its latest shortcut.
  Old 0.1.14 is intact under `bizencore-backups/1792143355872-0.1.14/`.
  No authentication/settings data was deleted, no OS protection was disabled.
- After the owner allowed Keychain access, the revoked saved session reached the
  ordinary sign-in form, not the workspace. The owner completed Google sign-in,
  and the task list, ordered account focus tabs, folder and pane layout returned.
  The first capture during authentication was blank while a later AX tree had
  workspace content; this was not counted as visual proof. After the owner
  finished and UI control was reacquired, screenshots showed the rendered UI.
- Launched this installed binary with `--validate-missing-cli`. Both Claude Code
  and Codex showed missing-CLI explanations, official install/auth links and a
  disabled launch control. Switching agents and refreshing diagnostics preserved
  the restriction. An independent process-tree check found no agent children.
  Normal resolver checks still found both existing executables. This is packaged
  main-process fault-injection acceptance, not an actual uninstall, a clean Mac,
  or an OS permission test. Existing folder-permission acceptance is recorded below.
- Returned the test pane to Claude, closed diagnostics, and normally quit the
  validation invocation. The first menu attempt did not exit; after confirming
  the menu selection, PID 68375 disappeared. Relaunched without any validation
  argument: the title no longer identifies validation, saved login restored
  without another sign-in, Claude 2.1.301 and Codex 0.163.0 were detected and
  launch became available. No CLI automatically restarted.
- 374 unit tests pass, lint has zero errors and the pre-existing hook warning;
  production renderer/native packaging and both desktop/task-tools browser suites
  pass. Frame width is 2px in ordinary and orchestration regression assertions.
- Still not publicly published: official download/feed activation and its final
  acceptance remain. Clawd permission is unresolved, retained by owner decision.
  Separate-Mac/account tests remain explicitly excluded, not passed. No exact
  revocation-latency or old-capability replay measurement is claimed.

## 0.1.15 Source Preparation (2026-10-16)

- Agent and orchestration frames now have a 2px border, retaining the existing
  colors and 8px corners. Workspace splitters remain a 1px visual line with their
  larger interaction target. Both browser suites assert the 2px frame.
- `--validate-missing-cli` is an explicit main-process-only fault injection that
  makes the shared diagnostic/launch resolver return no executable. It only
  removes availability for that invocation: no CLI files, PATH, authentication,
  permissions, IPC authority, or settings are changed. The window title identifies
  the validation invocation. This is not an actual uninstall or another-Mac test.
- All 374 unit tests pass. Packaged fault-injection acceptance is pending.
- The owner completed Clerk's email reverification for signing out only the
  Electron 44.7.0 device through their own Web account Security screen. The
  subsequent active-device list contains the Web browsers and iPhone but no
  Electron session. Installed 0.1.14 remains blocked with a reauthentication
  message after Reload. The previously idle Claude PID 46071 was independently
  confirmed absent; no real task was assigned to it. The initial native lock
  occurred before email reverification finished, so it is not proof of exact
  server-revocation latency. An old MCP capability was not replayed. Recovery
  through a fresh desktop login remains pending.
- The owner chose to keep Clawd in general distribution after being told its
  redistribution permission has not been established. This is a product choice,
  not permission from Anthropic or legal clearance. Keep provenance and the
  unresolved status in the asset review; do not label the artwork licensed.
- No new binary has been installed, public download enabled, or feed activated
  at this source-preparation step.

## Private 0.1.14 Candidate Acceptance (2026-10-16)

- Built from clean source `7ee5c10aed103232a208f22da4c495c42427fd6c`, tagged
  locally as `desktop-v0.1.14-candidate.1`. Renderer/native build ID
  `7fd8b819-47a1-471f-9d30-6f00a4dbfadf` and the pinned production Clerk/Convex
  profile match inside the archive. ZIP size is 147015371 bytes; SHA-256 is
  `cbb155221be75208d97110650471210fcbe422928286e30455c886f29ada3cd0`.
  Deep/strict ad-hoc signing, bundled notices and excluded-artwork checks pass.
  No Developer ID signature or notarization, publication or feed activation.
- Installed from the extracted ZIP at the existing stable app path. Installed
  0.1.13 was moved intact to
  `/Users/yuitotakizawa/Applications/bizencore-backups/1792127121934-0.1.13/`;
  the Desktop latest-app symlink and authentication/settings data were preserved.
  A separate idle legacy backup copy was found running before installation.
  After normal quit and SIGTERM did not stop that old copy, only its verified
  app process (with no CLI children) was stopped. This is not successful normal
  quit evidence for that legacy copy.
- The owner granted 0.1.14 Keychain access. Production authentication restored,
  including account-synced focus tabs. Native pane UI shows Clawd and one rounded
  metadata/terminal frame. On the dedicated Claude sample, header completion and
  undo synchronized to the server with user attribution; the detail button opened
  the independent inspector without an overlay. The sample was restored to
  unfinished before handing it to the actual CLI.
- Claude Code sample `316b0f53-8d6c-4fa0-a16d-03c98b53686c` completed a normal
  assigned-pane cycle: fresh MCP task read, read-only fixture verification,
  progress and completion. Independent MCP read returned done=true and
  completed_by_client=Claude Code; the pane showed the shared cyan check/amber
  dot. The CLI finished its response and exited through `/exit`.
- Codex sample `62ca8fe5-6647-44ec-8f28-3da74985b7b8` completed through the
  interactive orchestration terminal. Only that sample was selected, assigned to
  Codex, with manual next-task confirmation. Two tool permission prompts were
  approved once for that sample, not with session-wide or permanent permission.
  Fresh MCP read, fixture verification, progress, completion and re-read passed.
  Independent MCP read returned done=true and completed_by_client=Codex.
  Production Convex logged HTTP 200 for POST /desktop-mcp/complete-scoped,
  request ID `78c6d04606fe5fd3`, execution
  `fe9aa472-5bb8-41fe-a10a-50a15262fda9`. The manual completion-confirmation
  control stopped the CLI and displayed completed status. No next task started.
- Both pre-existing fixture files retained exact hashes, sizes, inodes, mtime
  and ctime: Codex 44 bytes, SHA-256
  `0d8aaa08aa18ea33faf0cee52a1bd01fc8ace33e2c1d43b13fdc33dc06349b34`;
  Claude 45 bytes, SHA-256
  `69dbcc98c7fd75e414d4e12c702c3930ba1022bd6c82ea937efff760db709db1`.
  Only dedicated acceptance samples were intentionally changed, not real work.
- Native menu Quit stopped the installed app and owned workers, verified with
  an empty process query. Earlier CUA keyboard/menu attempts did not prove exit
  and are not counted. Reopening the same 0.1.14 restored authentication without
  another sign-in, focus order, columns ratio 47.9486, fixture folder and the
  completed Claude assignment. No CLI automatically restarted.
- All 373 source unit tests pass in the normal local test environment. The first
  sandboxed attempt failed on localhost listen and shared Vite cache permissions;
  those failures were not treated as application test failures or passing tests.
- Remaining: actual server-side session revocation, installed missing-CLI case,
  public download/feed acceptance and asset distribution review including Clawd.
  Separate-Mac/account testing stays excluded by the owner. These are not silently
  marked passed; the desktop parent and installation acceptance task remain open.

## Backend Live, Next Desktop Candidate Pending (2026-10-16)

- Backend source `65c3c2b8e7a085381934f55d228352979f412eee` was deployed to
  `https://good-chinchilla-15.convex.cloud` with the existing locked Convex 1.37.0
  CLI and pushed to Web `main`. No schema, indexes, environment variables or auth
  settings were changed, and no real account task was edited for verification.
- Before/after production function specs differ only by the new desktop-only
  `POST /desktop-mcp/complete-scoped` route and optional string-array
  `allowedTaskIds` argument on `mcpTasks:complete`. All other function signatures
  are unchanged. Live unauthenticated calls to scoped/legacy desktop completion
  and ordinary MCP completion return 401; `/mcp/complete-scoped` stays absent (404).
- The backend-only branch has 172 passing unit tests and zero lint errors; codegen,
  TypeScript and production dry-run checks pass. The desktop branch incorporates
  the production commit and passes 373 tests, including the added HTTP authentication,
  trusted-account attribution and legacy compatibility regression.
- Git integration rebuilt the unchanged Web UI. Vercel deployment
  `dpl_BLhvvnJ7F1TdiniwvH5Vcsh3ZR1Q` is Ready at
  `https://chrct-hevxf4wws-bizencore.vercel.app`, aliased to app.bizencore.com.
- This completes backend preparation only. Installed 0.1.13 still uses its previous
  completion path; it does not retroactively gain scoped completion. Package and
  accept a matching new desktop candidate next. No desktop binary, version, tag,
  archive, installed app or desktop update feed was changed in this step.

## Source Freeze (2026-10-16)

- Source-only consolidation on `desktop/release-readiness-20261015`:
  `f251534` records the four review fixes; `fe6d2f0` records task/terminal frames,
  shared completion controls, independent details and provider/Clawd identifiers.
  `8d704bb` merges Web production `139b47d`, including account-scoped focus tabs
  and framed lock marks. The merge preserves all 37 previously changed files
  byte-for-byte and with the same file permissions; no focus migration was lost.
- Final documentation is recorded by the enclosing commit. This is not a new
  binary release: no version/tag has been assigned to these changes, and the
  installed 0.1.13, existing candidate tags, archives and rollback copies remain
  unchanged. At that source-freeze step, nothing was pushed, deployed, installed
  or publicly activated; the subsequent backend deployment is recorded above.
- Integrated checks: 372 unit tests pass; Web/MCP Apps and the preview desktop
  renderer build; Convex type check and an in-memory native-main bundle pass.
  Production configuration validation passes without creating a package.
  Desktop, orchestration/decomposition, authentication, account-focus and shared
  Web/desktop feature browser suites pass with synthetic accounts/IPC only.
  Lint has zero errors and the pre-existing terminal-launch hook warning.
- The next steps remain separate: deploy the scoped-completion backend before a
  matching desktop build, assign a unique release version, package and accept that
  actual candidate on this Mac, then finish asset review and public download/feed
  verification. In particular, Clawd is a simplified character rendering, not an
  official SVG or a blanket distribution-rights clearance; see ASSET_REVIEW.md.
  Real server-side session revocation remains unverified. Separate-Mac/account
  checks remain excluded by the owner, not silently marked as passed.

## Scope

Initial distribution targets macOS on Apple Silicon (arm64), through the company website.
No Apple Developer Program, Developer ID certificate, notarization, automatic installer,
Gatekeeper disabling or quarantine removal is part of this release plan.
Web production stays independent of desktop candidates. This branch starts at web commit
`850c0e1` and preserves the existing drag-and-drop, Life World and completion behavior.

## Verification On 2026-10-15

- Production 0.1.7 ZIP SHA-256 and deep/strict ad-hoc resource signature verified.
- Installed older versions are retained at separate backup paths; installed bundle is now
  0.1.9 candidate.2. The 0.1.8 acceptance results below remain version-specific evidence.
- Existing authentication and workspace data directories were not reset or removed.
- Native 0.1.7 authentication restore initially waited on macOS authentication. The owner
  subsequently confirmed Keychain permission; account/tasks/settings restored successfully.
- Native TOC clicks to a normal label and Life World, current-label alignment, the idle
  launcher and independent task detail panel were verified. No agent was launched.
- Public link attachment to the dedicated smoke subtask succeeded. Selecting two dummy
  files through the native picker exposed a CSP defect: the file-upload `.convex.site`
  origin was omitted. Both uploads failed before reaching the server.
- Candidate 0.1.8 fixes this by allowing only its pinned deployment's file site.
  The owner granted Keychain access after installation and authentication restored.
  The native multi-file picker successfully attached two dedicated dummy files. MCP
  returned both filenames and 44-byte sizes; independent downloads exactly matched
  both local originals. The public link and two files remained after a normal
  Command-Q (main process absent) and relaunch, with no agent automatically started.
  Native menu update guidance displays version 0.1.8 and the manual-update limits.
  Automated native link dragging did not produce an observable success. The owner
  then performed the dedicated Finder-to-row file drop and confirmed success. MCP
  independently returned a new attachment ID for `attachment-one.txt` (44 bytes),
  and its downloaded bytes exactly matched the original. Native file-drop acceptance
  is passed with owner operation plus independent server verification, not attributed
  to the unsuccessful automated drag.
  Version 0.1.7 is not a publishable candidate.
- No unrelated production task was edited, completed, deleted or handed to an agent.
- Source tests: 347 passed, including pinned-upload CSP, update notices, dependency inventory
  and distribution artwork exclusions.
  Shared Web and MCP Apps builds passed. Browser regression reproduces the old upload CSP
  failure and verifies two sequential uploads with the fixed policy using mocked transport.
- Root lint: no errors; existing terminal-launch hook dependency warning remains.
  Generated Electron stages/output are now excluded rather than linting bundled dependency comments.

## Launch Readiness And Version Identification

- Candidate 0.1.9 source `2cda245` is tagged locally as `desktop-v0.1.9-candidate.2`.
  Its ZIP SHA-256 is `f2f160d9996d43d0fb3edd7507bd07d085acbdcd4a93e3ec7914db66702e8048`.
  Strict ad-hoc signature and checksum were checked before installation; the previous
  installed copies and unpublished candidate.1 archive were retained, not overwritten.
- The desktop header, splash, native window title and native menu show 0.1.9.
  Renderer title changes no longer reset the native window to an unversioned name.
  Preview builds are labeled separately. Web branding is unchanged.
- `/Users/yuitotakizawa/Desktop/bizencore terminal 最新版.app` is a symbolic link to the
  stable installed bundle at `/Users/yuitotakizawa/Applications/bizencore terminal.app`.
  Build outputs and backups are not alternate daily launch targets. An older translocated
  copy was also running; it was normally quit with no agents active before installation.
- Startup resolves executables through the same routine used for diagnostics. Missing or
  failed diagnostics block UI launch and show installation/authentication links plus retry.
  Folder existence/type/access checks run before normal CLI spawn/MCP capability issuance.
- Unit tests exercise real missing/non-executable fixture paths and inaccessible directories.
  Browser tests verify missing/failed CLI guidance, disabled launch, retry, recoverable folder
  errors and version labels at 900/1380 widths. These use mock IPC, not production UI evidence.
- Installed 0.1.9 authentication restored after owner Keychain permission. For native folder
  acceptance, an empty dedicated folder was selected with no task assignment, then its mode
  was temporarily set to 000. Start displayed the Japanese access/choose-another-folder error
  and left the pane unstarted. Mode was restored to its original 700 and the empty pane closed.
  No existing CLI permissions, actual task content or operating-system protections changed.
- A separate, stronger macOS sandbox was attempted to hide only the installed Claude binary
  from one app run. That run did not stay alive, so it is NOT a passed native missing-CLI test.
  No renderer sandbox was disabled to make it run. Normal unrestricted launch was restored;
  both actual installed CLI paths/versions were detected again and no agents were started.
- Native missing-CLI acceptance remains open: both CLIs are installed on this Mac, and the
  successful unit/browser fixtures do not silently substitute for that production UI case.

## Desktop Split Layout (0.1.10 Private Candidate)

- Outer task/terminal layout supports columns or rows. Rows place tasks above terminals,
  with the independent inspector beside the upper task area. Terminal expansion keeps
  an open inspector in a separate column; zero agents collapse to a bottom toolbar.
- Direction and independent width/height ratios are scoped to account/environment.
  Older workspace data defaults to columns without losing pane assignments or folders.
  Direction changes preserve mounted terminals and never launch or stop a CLI.
- 348 unit tests, Electron type check, Web/MCP builds and existing desktop/auth/shared-task/
  orchestration browser suites pass. Lint has no errors and one pre-existing hook warning.
  Browser tests cover pointer/keyboard resizing, short/narrow windows, non-overlapping
  details, live input/output and native resize calls, terminal-node continuity and restart
  persistence without auto-start. Native IPC is mocked in these browser tests.
- Candidate source: `a4612b1d5a2aeeb9a39aa2bfaf6d8fc621e1821e`.
  ZIP SHA-256: `415b81093cec9b75d0a333e57b08adbc8c2224080463c61de9cd16b3677bb721`.
  Packaging, archive checksum and deep/strict ad-hoc signature checks pass; `published: false`.
- Installed locally after normal exit with no active agents. 0.1.9 candidate.2 was retained
  in the versioned backup directory; the existing Desktop latest-app symlink stays valid.
  After owner Keychain permission, 0.1.10 restored the production task list. Native columns/
  rows switching, keyboard adjustment (50 to 52), pointer adjustment (52 to 48.37562),
  top-row independent details and zero-agent bottom-toolbar collapse were observed.
  No agent was launched and no task content edited. A subsequent normal quit/restart
  again stopped at authentication, so native restart-layout acceptance remains pending.
  Auth data/security settings were not cleared or changed.
- No Web production deployment, public archive/feed activation or real task execution.

## White Theme And Splitter Refinement (0.1.11)

- White-theme interactive outlines use a dedicated control token rather than the pale
  structural divider color. Normal and Life World checkboxes, memo/completion/context
  fields and outlined buttons are checked at >=3:1 against both page and card backgrounds;
  inactive Today text at >=4.5:1. Dark checkbox colors and completion styling are retained.
- Workspace splitters paint a 1px pseudo-element inside the existing transparent 6px
  hit target, including horizontal/vertical directions and the independent inspector.
  Hover/focus colors affect only the thin line, without changing workspace dimensions.
- Browser assertions cover painted-line dimensions, retained pointer and keyboard resizing,
  and shared Web/desktop contrast. Synthetic screenshots are used, not private task data.
- 348 unit tests, Web/MCP builds, normal and MCP-mode desktop browser suites and shared
  task/contrast regression pass. Lint has no errors and the same existing hook warning.
- Private 0.1.11 source: `611bb6f8486069d12da604302a940d94d54be9e5`.
  ZIP SHA-256: `733a3b7d709789fa1276fbb1b5c13cc2b0d58880972f2858c3b33aff21984381`.
  Archive checksum and deep/strict ad-hoc signature checks pass; `published: false`.
  Installed at the stable local app path with 0.1.10 retained in a versioned backup.
  Native startup/version confirmed; final signed-in white-theme inspection awaits owner
  Keychain permission. No auth data, operating-system protection or public feed changed.
- Before updating, a separately running backup 0.1.8 had one unstarted pane and was quit
  normally. The 0.1.10 authentication-screen process did not respond to UI Quit or SIGTERM;
  only that verified executable/PID was force-stopped with no agents running. This is not
  counted as a successful normal-shutdown/restart acceptance. Avoid running old and new
  production-profile copies simultaneously; their concurrent storage behavior is not verified.

## Update Notice

The desktop checks only `https://bizencore.com/downloads/desktop/latest.json`, without
account credentials. Only a newer, published, matching-architecture production release
is accepted. Invalid, unavailable, redirected or oversized responses fail closed.
Preview builds never poll the production release feed.

The header icon opens the fixed official download page. It does not reload the renderer,
stop agents, replace the application, import a Web build, or start a downloaded executable.
Actual installation remains a deliberate manual update after work has ended.

The release feed must remain unpublished until the referenced archive exists publicly,
its hash/size are independently verified, and candidate acceptance has passed.
Adding a notice to a new build does not retroactively update 0.1.7 or older applications.

## Source And Distribution Preparation

- Desktop/shared UI baseline committed on `desktop/release-readiness-20261015` at `de3e800`.
- Original dirty application and LP checkouts retained; no Web production deployment or
  main-branch merge performed.
- Official download page prepared on a separate LP branch. Its feed is `published: false`.
- Download tests verify published metadata and fail closed for unpublished/invalid feeds;
  layouts checked at 1440, 390 and 320 pixels using synthetic application screenshots.
- Japanese install/update/rollback, data/permission and public-reporting instructions prepared.
- 226 locked dependency notices inventoried. The five missing root texts were supplemented
  from the installed README, same-version parent package or documented official sources.
  The owner confirmed no redistribution permission for the three illustrations;
  desktop builds exclude them and use licensed Lucide icons or brand-only UI instead.
  The desktop brand icon was regenerated from the repository's documented `bc` generator.
  Electron/Chromium notices are explicitly included as readable app resources; their
  presence in the final ZIP was verified.
- Release builds now require a clean committed checkout and bind the source commit into metadata.
- Private local tag `desktop-v0.1.8-candidate.2` binds candidate source `8c095b9`.
  ZIP SHA-256: `bbcce556992ba265b2aee18ccca86e937832abd9189430e1e97dd98365c86e89`.
  The earlier never-published candidate is retained under `out-electron/rejected`.

## Release Gates

- [x] Complete installed-candidate authentication, TOC and context-drop acceptance.
- [ ] Verify the updated notice in the installed next candidate, not only a browser fixture.
- [x] Inventory dependency/runtime notices and exclude the three owner-confirmed unlicensed illustrations.
- [x] Confirm declared minimum macOS 13 against Electron 44 and the packaged app's
      LSMinimumSystemVersion (not a claim that every supported OS version was tested).
- [x] Complete source baseline commit; candidate builds require a clean checkout and record its commit.
- [ ] Host the immutable ZIP, checksum, metadata, installation guide and release notes.
- [ ] Verify the public download in a normal browser with quarantine retained.
- [ ] Activate the published release feed only after acceptance and archive verification.

The owner excluded separate-Mac and separate-account native verification from this
release's acceptance gates. These are disclosed untested cases, not passed tests.
Server-side session revocation acceptance remains a separate disclosed gap.

## Candidate Freeze And Authentication Stability (0.1.13)

- Freeze new features while stabilizing authentication, one-candidate acceptance and
  unpublished distribution preparation. No public deployment or feed activation is authorized.
- Claim Electron's profile-scoped single-instance lock before opening Clerk storage on macOS
  as well as other platforms. Repeated launches activate the existing window. Legacy builds
  do not implement this gate and must not be run alongside the new production profile.
- Keep Clerk's pinned encrypted token adapter, file path and permissions. Run it in a
  dedicated owned Electron helper over private IPC; never forward tokens to stdout/stderr,
  CLI arguments, public logs or a plaintext fallback. The helper verifies its direct parent's
  executable before reading token storage and uses no browser window or browser profile.
- Register the helper with the existing process guard before dispatching storage requests.
  Bound startup, storage waits and payload sizes; serialize mutations and reject replayed
  request IDs. Quit/timeout kills only the owned helper, including a blocking native wait.
- Pending-auth UI explains long OS approval/network waits without declaring a pending
  sign-in failed after 15 seconds. Native server authorization is still mandatory before
  revealing task data or starting a CLI; no cached token bypass is introduced.
- 357 unit tests pass, including a genuinely blocked child-process test, token storage
  compatibility/mutation races, account/environment storage boundaries and process cleanup.
  Browser authentication regression passes. Synthetic results are not substituted for
  real-account evidence; signed-in candidate acceptance is recorded below.
- The owner approved 0.1.11's Keychain prompt and its signed-in task list was observed.
  Its normal Command-Q shutdown left no desktop process before the next installation.
- 0.1.12 archive source `38fb941` and SHA-256
  `c7651459238881f7ea19a03486d6caec562131cdc62a2941ca48d53d3fd514b2`
  passed metadata/resource-signature/notices checks and was privately installed with
  0.1.11 backed up. Pending-auth UI stayed responsive; Command-Q removed main,
  auth helper and guard without force-terminating main. Signed-in restore was not verified.
- An extra packaged standalone-worker rejection test failed: an unavailable parent path
  could throw before app-ready and leave an Electron error dialog. Do not publish 0.1.12.
  The 0.1.13 fix fails closed on missing/relative/unresolvable parent paths. A real Electron
  run of the bundled fixed worker with an unauthorized Node parent exited 2 without
  timing out or accessing storage. Packaged-candidate acceptance remains required.
- 0.1.13 archive source `bcde500a100d868a0f97437315d591fcde66ea62`, SHA-256
  `782841773adc21936d384a17d51fe0b2a9d629d40c747bbacfc26710f7bf56c3`,
  147012558 bytes. Metadata, ZIP checksum, deep/strict resource signature and nonempty
  runtime/license/install notices passed; no Developer ID signature or notarization.
  Packaged standalone-worker rejection exited 2 with no IPC messages or error output.
- Privately installed 0.1.13 at the fixed Applications path after normal Command-Q of
  0.1.12; the installer verified no desktop main/auth/guard remained before replacement.
  Backup: `bizencore-backups/1792058983772-0.1.12/bizencore terminal.app`.
  Repeated executable launch exited 0 and preserved the original main PID: one main,
  one authentication helper, one process guard. Version/title and responsive pending UI
  were observed. The owner subsequently reported approving both 0.1.12 and 0.1.13;
  only the currently installed 0.1.13 was inspected. Its signed-in production task list,
  previous workspace folder, one unstarted pane and dark theme were visibly restored.
  Signed-in restart and a new CLI work cycle were subsequently verified as recorded below.
  Nothing was deployed, uploaded or publicly enabled.
- Subsequent CUA Command-Q/native-menu Quit attempts did not establish main-process
  termination: PID 26435 remained with the task window accessible and no stop-agent
  control. A thread sample showed an AppKit event loop, not a blocking native Keychain
  call. Some CUA actions reported changed state, so neither an automation targeting
  issue nor a product shutdown defect has been ruled out. No forced termination or
  authentication deletion was used. The owner was asked for one manual menu Quit.
  A separate synthetic real-Electron run using the same lifecycle module and an idle
  hidden window reached approved before-quit, close and will-quit and exited 0 without
  timeout; this is isolation evidence, not packaged signed-in acceptance.
- The owner then reported normal menu Quit succeeded. Independent process inventory
  confirmed no production desktop main/auth/guard remained. Reopening the same installed
  0.1.13 restored the signed-in list without another owner authentication action,
  columns layout at width 46, the previous workspace folder and one unstarted Claude pane.
  Earlier CUA Quit failures are not a reproducible product shutdown defect and are not
  counted as successful exits; the manual exit plus inventory is separate positive evidence.
- Dedicated sample `0cdb8eee-d2b3-423e-8613-86849452b87a` was created under installed
  acceptance, assigned to the existing pane in execution mode, and explicitly launched.
  Native select menus required keyboard navigation and the confirmation dialog required
  screenshot-grounded coordinates; no product source was changed to bypass either.
  Real Claude Code fetched the current task with desktop MCP `work_on_task`, used Read
  only on `claude-readonly.txt`, and called `record_task_progress` and `complete_task`.
  Independent MCP read confirmed done=true and completed_by_client=Claude Code.
  The original 45 bytes matched exactly, SHA-256
  `69dbcc98c7fd75e414d4e12c702c3930ba1022bd6c82ea937efff760db709db1`;
  inode 252535280, mtime/ctime 1791906594434.796 were unchanged before/after.
  No real tasks, other files, permissions or global CLI configuration were modified.
- Claude completed its final response and exited normally via `/exit`. Subsequent CUA
  Command-Q succeeded and process inventory again showed no production main/auth/guard.
  Reopening 0.1.13 again restored authentication without further owner action, the same
  layout/folder, the sample's completed assignment, and no running CLI/stop-agent control.
  This verifies the agreed one-pane startup/work/progress/normal-exit/restart cycle on
  this Mac. Codex's prior native acceptance remains prior-version evidence, not a new
  Codex cycle on 0.1.13. Separate-account/Mac and real server revocation remain untested.

## Beta Review Fixes (2026-10-16)

- Scoped orchestration completion uses the desktop-only `complete-scoped` endpoint.
  The existing completion mutation validates the approved IDs, current descendants,
  unfinished children and locks before any writes in the same transaction. Ordinary
  Web/MCP bulk completion retains its previous behavior. Deploy this backend change
  before distributing a matching desktop build; old servers fail closed, never fall
  back to bulk completion. The installed 0.1.13 does not contain these fixes.
- Diagnostics, MCP probes and PTY launches share one absolute, deduplicated PATH,
  preserving existing PATH precedence while adding the known user/Homebrew directories.
  A real env-node fixture verifies a minimal Finder-style environment.
- Codex history capture accepts a verified Node/Bun launcher and probes only native
  Codex descendants whose identities and ancestry remain valid before/after metadata
  reads. Unrelated, detached and PID-reused processes remain excluded.
- Owned-history lookup streams filenames instead of exhausting a shared 4096-entry
  allowance on unrelated history. Ownership, exact folder, symlink and bounded metadata
  read checks remain. Unscoped discovery keeps its original bounded fail-closed scan.
  Regression coverage includes more than 4096 unrelated old history files.
- Regression checks use synthetic accounts/CLI fixtures and a real loopback MCP through
  the HTTP route and mutation. They are not new installed-candidate acceptance. No
  deployment, public feed activation or installed application replacement was performed.
