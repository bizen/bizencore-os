# Desktop Release Readiness

## Scope

Initial distribution targets macOS on Apple Silicon (arm64), through the company website.
No Apple Developer Program, Developer ID certificate, notarization, automatic installer,
Gatekeeper disabling or quarantine removal is part of this release plan.
Web production stays independent of desktop candidates. This branch starts at web commit
`850c0e1` and preserves the existing drag-and-drop, Life World and completion behavior.

## Verification On 2026-10-15

- Production 0.1.7 ZIP SHA-256 and deep/strict ad-hoc resource signature verified.
- Installed 0.1.5 retained at a separate backup path; installed bundle is now 0.1.7.
- Existing authentication and workspace data directories were not reset or removed.
- Native 0.1.7 authentication restore initially waited on macOS authentication. The owner
  subsequently confirmed Keychain permission; account/tasks/settings restored successfully.
- Native TOC clicks to a normal label and Life World, current-label alignment, the idle
  launcher and independent task detail panel were verified. No agent was launched.
- Public link attachment to the dedicated smoke subtask succeeded. Selecting two dummy
  files through the native picker exposed a CSP defect: the file-upload `.convex.site`
  origin was omitted. Both uploads failed before reaching the server.
- The next candidate fixes this by allowing only its pinned deployment's file site.
  Native file/drop acceptance must be repeated; 0.1.7 is not a publishable candidate.
- No unrelated production task was edited, completed, deleted or handed to an agent.
- Source tests: 342 passed, including pinned-upload CSP, update notices and dependency inventory.
  Shared Web and MCP Apps builds passed. Browser regression reproduces the old upload CSP
  failure and verifies two sequential uploads with the fixed policy using mocked transport.
- Lint: no errors; existing terminal-launch hook dependency warning remains.

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
  Asset permissions remain unconfirmed; an inventory is not a blanket legal clearance.
- Release builds now require a clean committed checkout and bind the source commit into metadata.

## Release Gates

- [ ] Complete installed-candidate authentication, TOC and context-drop acceptance.
- [ ] Verify the updated notice in the installed next candidate, not only a browser fixture.
- [ ] Review dependency notices and bundled art/font redistribution conditions.
- [ ] Confirm minimum macOS support against the actual Electron runtime; the Swift helper
      deployment target alone is not a supported-OS claim.
- [x] Complete source baseline commit; candidate builds require a clean checkout and record its commit.
- [ ] Host the immutable ZIP, checksum, metadata, installation guide and release notes.
- [ ] Verify the public download in a normal browser with quarantine retained.
- [ ] Activate the published release feed only after acceptance and archive verification.

No second Mac is available. Fresh-machine, separate-account and server-side session
revocation acceptance remain disclosed gaps, not silently marked complete.
