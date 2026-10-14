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
- Native 0.1.7 authentication restore did not finish. A macOS SecurityAgent process
  was present; its protected dialog could not be inspected by the automation.
  User confirmation is needed to identify any local authentication prompt.
- Do not count 0.1.7 TOC navigation, native context drops, or normal restart as verified yet.
- No unrelated production task was edited, completed, deleted or handed to an agent.
- Source tests: 337 passed. Shared Web and MCP Apps builds passed.
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

## Release Gates

- [ ] Complete installed-candidate authentication, TOC and context-drop acceptance.
- [ ] Verify the updated notice in the installed next candidate, not only a browser fixture.
- [ ] Review dependency notices and bundled art/font redistribution conditions.
- [ ] Confirm minimum macOS support against the actual Electron runtime; the Swift helper
      deployment target alone is not a supported-OS claim.
- [ ] Complete source commit and bind the final archive to its source commit.
- [ ] Host the immutable ZIP, checksum, metadata, installation guide and release notes.
- [ ] Verify the public download in a normal browser with quarantine retained.
- [ ] Activate the published release feed only after acceptance and archive verification.

No second Mac is available. Fresh-machine, separate-account and server-side session
revocation acceptance remain disclosed gaps, not silently marked complete.
