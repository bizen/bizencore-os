# Distribution Asset Review

Public release remains gated on this review. Dependency licensing does not grant rights
to project images. Do not infer permission just because an asset is in the repository.

## Excluded From Desktop Distribution

- The owner confirmed no redistribution permission for `src/assets/cirno.png`,
  `public/quests/mainquest.png` and `public/quests/tanomigoto.png` on 2026-10-15.
- Desktop builds use a brand-only splash, no mascot, and Lucide Flag/HandHelping
  quest icons. Web artwork is unchanged. The source images are not shipped in ZIPs.
- The staged renderer removes copied public quest images and rejects matching
  original image hashes even if renamed. The embedded MCP app is also inspected.

## Generated Brand Icon

- The desktop icon was rebuilt directly from `public/icons/icon-512.png`, whose
  repository-owned generator is `scripts/generate-app-icons.mjs`: white `bc`
  letterforms on Midnight Black, using Instrument Serif from the pinned Google Fonts
  source documented in `public/icons/README.md`. No third-party illustration is used.
- Lucide icon license text is included in the dependency notices.

Keep public binaries and the latest-release feed unpublished until the updated
installed candidate has passed acceptance. This inventory is not a blanket legal clearance.

## Fonts And Dependencies

- Agent identification graphics in `desktop/AgentLogo.tsx` use the unchanged
  OpenAI Blossom path served on https://developers.openai.com/ (retrieved
  2026-10-16), in black/white only. Claude Code uses a simplified pixel rendering
  of its Clawd character, not the Claude star logo or an official SVG export.
  The reference is the Claude Code welcome-screen character; product source:
  https://github.com/anthropics/claude-code . Its orange and dark eyes stay visible
  in light and dark themes. No third-party fan illustration is bundled.
  These are small identifiers beside the actual CLI names, not bizencore branding
  or an endorsement claim. OpenAI marks belong to OpenAI; Claude marks belong to
  Anthropic; the Clawd character is associated with Anthropic. OpenAI usage
  guidance: https://openai.com/brand/ . Availability of
  artwork is not a blanket redistribution license or a partnership approval.
  Distribution notices include ownership and provenance for these symbols.

- Shared UI fonts are requested from Google Fonts; do not claim they are bundled or
  fully offline. If they become bundled, include the exact supplied license files.
- `dependencyNotices()` inventories the locked dependency graph, copies supplied
  root license/notice text, and reports missing declarations or text for manual review.
- Electron/Chromium license files must remain in the packaged runtime. Verify their
  presence in the final archive instead of assuming packaging preserved them.

## Screenshots

The download-page screenshot is a browser fixture using synthetic tasks and an idle
launcher. It does not include the owner's real task list, account details or CLI history.
