# bizencore terminal for macOS

This beta uses your production bizencore account. The ZIP targets Apple Silicon (arm64).

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

## Update

From 0.1.19 onward, the update button downloads and verifies the new release.
Choose “Restart to update” when ready. Active agents use the existing quit
confirmation; cancelling leaves them running. Login, tasks and settings are
retained. Restored panes remain stopped. A failed startup restores the old app.
The app must be in a writable Applications folder. OS protections are not disabled.

Versions through 0.1.18 need one manual replacement to acquire this updater:
quit the old app, verify the new ZIP checksum, keep a backup and replace the app
in the same location. Do not delete account data. macOS may request approval for
the downloaded app. Restoring the old app does not roll back cloud or user data.

## Sign Out

Sign-out locks the desktop workspace and stops local agents. It does not uninstall
the separately installed CLIs or sign out of their own provider accounts.
