# Supplemental Dependency Texts

The installed package lock is the version source. Supplemental text is used only for
the explicitly matched version and declared license; different versions must be reviewed.

- `standardwebhooks@1.1.1`: npm gitHead is
  `b4d2c14fc5b4ccff3ff271e3b087dff812254c59`. Its JavaScript library is under
  `libraries/LICENSE` (MIT, Svix copyright), not the repository-root specification license.
  Text: https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE
- `mcp-handler@2.1.1`: installed package declares Apache-2.0; repository tag `v2.1.1`
  resolves to `7c8fe0a6d18e2fd112739360ff587cfcd31a1472`. No LICENSE/NOTICE file was
  present in that source tree. Include the official Apache-2.0 text without inventing a
  package-specific copyright notice: https://www.apache.org/licenses/LICENSE-2.0.txt
- `type-fest@2.19.0`: package and readme declare `(MIT OR CC0-1.0)`; its npm gitHead is
  `d07df21f8b79e35ad8411cb9ceb8b5cb8f40f9d4`. Include the CC0-1.0 option's text:
  https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt
- `glob-to-regexp@0.4.1`: the installed README includes the complete author's BSD text.
- `@esbuild/darwin-arm64@0.27.0`: use installed `esbuild@0.27.0/LICENSE.md` from the same version.

This inventory preserves dependency declarations and supplied text. It is not a statement
that the entire product's artwork, trademark, privacy or distribution review is complete.
