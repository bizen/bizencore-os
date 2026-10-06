# App Icons

White `bc` on Midnight Black (`#0a0b0c`). Instrument Serif Regular for `b`,
Italic for `c`. The artwork is opaque and fits the central 80%-diameter safe
circle for maskable icons. Corners are left square for the operating system
to crop.

Regenerate from the repository root:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs node scripts/generate-app-icons.mjs
```

Set `PLAYWRIGHT_CHROME_CHANNEL=chrome` to use installed Chrome. The script
downloads a pinned version of Instrument Serif from the official
[Google Fonts repository](https://github.com/google/fonts/tree/0b58fb370093f9a9f4ff785d94405710b79de67c/ofl/instrumentserif).
Instrument Serif is licensed under the
[SIL Open Font License](https://github.com/google/fonts/blob/0b58fb370093f9a9f4ff785d94405710b79de67c/ofl/instrumentserif/OFL.txt).
Normal builds use the committed PNGs and need no font download or Playwright.

Home-screen setup covers icons, naming and standalone launch only. There is
no service worker, offline caching, notification permission or install prompt.
