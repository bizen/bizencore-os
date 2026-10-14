# Distribution Asset Review

Public release remains gated on this review. Dependency licensing does not grant rights
to project images. Do not infer permission just because an asset is in the repository.

## Pending Owner Confirmation

- `src/assets/cirno.png`: source artist, permission/license and required attribution
  for redistributing this specific illustration are not documented.
- `public/quests/mainquest.png` and `public/quests/tanomigoto.png`: source and
  redistribution/attribution conditions need to be documented.
- Desktop and home-screen logo icons: confirm ownership of the generated design.

Do not remove or replace the user's chosen artwork without agreement. Until permission
is established, keep public binaries and the latest-release feed unpublished.

## Fonts And Dependencies

- Shared UI fonts are requested from Google Fonts; do not claim they are bundled or
  fully offline. If they become bundled, include the exact supplied license files.
- `dependencyNotices()` inventories the locked dependency graph, copies supplied
  root license/notice text, and reports missing declarations or text for manual review.
- Electron/Chromium license files must remain in the packaged runtime. Verify their
  presence in the final archive instead of assuming packaging preserved them.

## Screenshots

The download-page screenshot is a browser fixture using synthetic tasks and an idle
launcher. It does not include the owner's real task list, account details or CLI history.
