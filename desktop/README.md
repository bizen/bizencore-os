# bizencore terminal desktop

The desktop product uses Electron, React and xterm.js. The Web App and its
authenticated sync are reused; native functionality lives in `electron/`.
The former Tauri feasibility prototype and Rust build caches have been removed.

See [the Electron guide](electron/README.md) for development, authentication,
verification evidence and release requirements. Development and production
profiles must stay separate. Installing or building locally does not publish
the desktop product or change the Web deployment.

```sh
npm install
npm run electron:build
```

Desktop requires sign-in before tasks or native agent commands are available.
Claude Code and Codex are installed and authenticated separately by the user.
Stored pane configuration never launches an agent automatically.

## Optional task tools

The agent toolbar opens a cross-label task selector. Orchestration runs a
confirmed task set sequentially through an interactive, dedicated CLI terminal,
using the locally installed Codex and Claude Code. Output and permission prompts
are visible, and the user can type replies directly. A fresh, scoped session is
created per task; manual panes are not repurposed. The terminal shares the
workspace theme and terminal-only font preference. Command-plus/minus zooms the
entire app instead.
Explicit assignments override alternating allocation. Manual panes must be
stopped first; parallel orchestration and capability-based routing are not
part of this first version.

Task-based decomposition is a separate, read-only operation. The user reviews
and edits the proposed owners, notes and completion criteria before applying
it. Application reuses existing subtasks and updates one context document.
It does not start execution, and there is no automatic AI-owner-only execution
mode yet. Ordinary execution never requires decomposition.

Native operations require the existing account authorization and isolated
environment MCP. Their capabilities permit only the selected task subtree;
planning permits reads only. Executions cannot add, delete, move or edit other
tasks. Parent completion requires already-completed unlocked descendants.
CLI permission checks are not bypassed. Default progression is manual: the user
checks the latest MCP state, confirms termination of that CLI, and advances.
Optional automatic progression terminates the current CLI only after MCP confirms
the entire unlocked task subtree is complete. Human terminal input suspends
automatic progression. An incomplete or locked task never auto-advances, and
process exit/output alone cannot complete it. Permission questions remain in the
terminal. Stop cancels pending preparation as well as the owned process tree;
another launch waits for verified cleanup. Output stays in bounded, in-memory
scrollback and is not persisted by bizencore.

Decomposition still uses a 30-minute, bounded structured-result operation.
Pause finishes the current operation; stop cancels the owned process tree and
does not revert changes already made. Restored queues never auto-start.

Public distribution still needs review of each provider's authentication and
subscription integration conditions. This work does not publish the app or
configure cloud execution. Live development-account checks verified Claude
Code/Codex sequential execution, waiting/resume and decomposition/document reuse;
see the dated evidence in `electron/README.md`.

Distribution uses a locally prepared ZIP and manual updates, without Apple
Developer Program membership, Developer ID signing or notarization. The former
signed-release/native auto-updater paths have been removed. With explicit user
authorization, the private production candidate passed Google sign-in, both
CLIs' isolated production MCP file/progress/completion cycles, and login restoration
after restart on this Mac. Safari-downloaded installation, manual update from
0.1.2 to 0.1.4, rollback and return to 0.1.4 were also checked, with quarantine
retained and the user granting per-build macOS approval. Login, task state,
remembered work folder and font preference survived; agents did not auto-start.
Production logout hid tasks/native controls and Google re-login restored the
same account. Separate-account and server-side revocation acceptance remain.
These checks are specific to this Mac; they do not establish public-release
readiness or Apple approval. See `electron/README.md` for evidence and limitations.
