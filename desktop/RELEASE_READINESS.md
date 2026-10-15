# Desktop Release Readiness

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

No second Mac is available. Fresh-machine, separate-account and server-side session
revocation acceptance remain disclosed gaps, not silently marked complete.
