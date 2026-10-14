# bizencore terminal for macOS

This private candidate uses your production bizencore account. It is not a
public release. The current ZIP targets Apple Silicon (arm64).

## Install

1. Keep the ZIP, SHA256SUMS and artifact.json from the same release together.
   Compare the ZIP's SHA-256 with SHA256SUMS before installation.
2. Extract the ZIP. Quit any running copy of bizencore terminal first.
3. Move bizencore terminal.app into your Applications folder. A per-user
   Applications folder is also supported. Keep only one active installed copy.
4. Launch the app and sign in to your bizencore account. Installing the app does
   not install or sign in to Claude Code or Codex; configure those separately.
5. Select an agent and an existing working folder. Assigning a task or restoring
   a workspace does not automatically launch an agent.

## macOS Security

This candidate has no Developer ID signature or Apple notarization.
The bundle has a local ad-hoc signature for integrity, not a verified developer
identity or notarization. This does not grant Gatekeeper approval. macOS may
refuse to open a downloaded copy. If blocked, stop and review the distribution
decision; do not disable Gatekeeper or remove quarantine attributes. A successful
local build launch does not establish downloaded-copy compatibility.

## Manual Update

1. Finish or explicitly stop agent work. Stopping does not undo changes already
   made to files or synchronized tasks. Keep important work backed up separately.
2. Quit the app with Command-Q. Closing its window is not quitting on macOS.
3. Verify the new ZIP's checksum, then extract it outside the installed app.
4. Move the previous installed app to a versioned backup folder. Move the new
   app into the same installation path. Never replace a running app bundle.
5. Launch the new version. Check your account, tasks and saved pane settings.
   Restored panes should remain stopped until you explicitly launch them.
6. If the update fails, quit it and move the previous app back to the same path.
   Keep account data in place; do not delete the app's Application Support folder.

There is no automatic update download, installer or background agent launch.
Rollback is limited to versions whose local data formats remain compatible.
Restoring an old app does not roll back cloud tasks or working-folder changes.

## Sign Out

Sign-out locks the desktop workspace and stops local agents. It does not uninstall
the separately installed CLIs or sign out of their own provider accounts.
