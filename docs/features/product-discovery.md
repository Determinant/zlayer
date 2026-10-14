# Public product page and discovery

[Documentation](../README.md) / Features

The map and installed PWA start at `/`. `/about/` is a separate public product page
for visitors evaluating ZLayer and for search/AI retrieval. The existing compact
About dialog stays in Settings; **Features and getting started** opens the public
page in another tab. It does not replace the dialog or interrupt the workspace.

## Content and build

`about/index.html` owns the public overview, installation steps and FAQ.
`src/site/about.css` uses the existing B612 fonts and generated dark theme tokens;
the page follows the popup's colors and typography without loading the application
UI, map, workers or live feeds. Vite builds it as a second HTML entry, with all
product text and WebApplication JSON-LD present in the initial response. Native
links and disclosure elements work without JavaScript. No client router or server
rendering runtime is required. Its stylesheet is emitted under `/about/`, outside
the PWA shell inventory; About-only CSS must not become an app installation or
update dependency. Shared fonts remain part of the app's existing assets.

The README introduces the product, links directly to the app and product page, and
keeps developer instructions below the pilot-facing overview. Keep factual claims
consistent with the owning feature guides and roadmap. In particular, cross-platform
use does not imply cloud sync; cached browsing does not imply verified regional
coverage; experimental/device qualification limits must remain visible. Structured
data describes only capabilities and pricing also stated on the visible page.
Answer pilot questions directly on the page instead of sending readers to engineering
guides. The offline FAQ names the saved charts, TPP documents, navigation, terrain
and published glide hints, and distinguishes regional downloads from cached reports.
The data-source FAQ credits the providers, including FAA NMS for NOTAMs.

`public/about/workspace.webp` is a 3200 × 2000 screenshot of the public app captured
at 2× device pixel density, with route terrain contours and airport details open.
It is shared by the README, product page and social previews. Its depicted dates
are illustrative, not evidence of current source freshness or device qualification.
Refresh it when the interface changes materially. The screenshot is outside the
offline shell inventory, so it does not add a download requirement to app installation.

## URLs and crawler access

The production origin is `https://zlayer.tedyin.com`. The app and product page each
have a self-referencing canonical URL. The host redirects `/about` to `/about/`,
serves `about/index.html` at that directory, and serves unknown pages as real 404s.
The service worker bypasses only same-origin `/about` and `/about/...` requests,
including query strings and missing files, before any cache or reset handling.
These URLs use ordinary browser/network responses; the public product page is not
a promised offline resource. Other URLs retain the existing PWA navigation and
offline-cache behavior, including the app-shell fallback for navigation outside
`/about/`. The host's 404 contract applies to direct requests without that fallback.

Window coordination also stays unchanged. Every open window still counts during
shell retention and coordinated reset: an older worker may have served an actual
workspace at a non-root URL, so its URL alone cannot establish that it is a public
page. An open About tab can defer old-shell cleanup and is redirected to the reset
screen when the user explicitly clears local app data.

`public/sitemap.xml` lists the two public pages. `public/robots.txt` allows public
page crawling, including search/AI crawlers, while excluding API endpoints, chart
payloads, proxied PDFs and source archives from crawling. This is a crawler policy,
not access control. CDN/WAF policies can still block access independently.

The app's noscript message links to `/about/`; the README, sitemap and About dialog
also link there. Neither a sitemap, JSON-LD nor access permission guarantees
indexing, ranking, rich results or AI recommendations. There is no special AI-only
content or user-agent-specific page. `llms.txt` is not required for this design.

## Deployment and verification

Publish the complete Vite output, including `about/`, `robots.txt`, `sitemap.xml`
and generated assets. The existing Caddy directory file server serves these paths;
other hosts must preserve directory-index handling and must not rewrite every
request to the app. Keep `/sw.js` uncached so existing installations can obtain the
navigation fix. An older active worker can still intercept public-page navigation
until its update activates; confirm behavior after updating an existing installation.

`test/e2e/discovery.spec.ts` checks the built page without JavaScript, discovery
resources, compact/mobile layout, the retained dialog, public navigation after
shell caching, 404 responses under `/about/`, offline return to the saved app, and
reset with an About tab open. `test/service-worker-reset.test.ts` checks the narrow
network bypass, cached app navigation, retention for non-root windows and reset
coordination. Existing update, reset and offline regressions cover the broader
shell lifecycle. Follow the [verification guide](../development/local-development.md#verification)
for release checks.

After deploying:

1. Fetch `/about/`, `/robots.txt` and `/sitemap.xml`; check their content types and
   content, canonical URLs, image/stylesheet availability and absence of `noindex`.
2. Check Cloudflare's effective robots response and bot policies. Public pages
   should be accessible to Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot and
   user-directed retrieval. Google-Extended separately controls certain Gemini
   grounding and training uses; decide that policy explicitly rather than assuming
   it is identical to Google Search access.
3. Verify the site in Google Search Console and Bing Webmaster Tools, submit the
   sitemap, and inspect `/about/`. Confirm indexing through their reports; submitting
   a URL is not confirmation that it has been indexed.
4. Track search queries/referrals and periodically check realistic EFB discovery
   prompts, noting which sources assistants cite and whether their descriptions
   match the current product. Do not treat one generated answer as a stable rank.

GitHub's homepage field points to the app. Its description and topics identify the
project as a free, open-source EFB/flight planner, with aviation, weather, charts,
PWA and offline capabilities. These repository settings are separate from source
files and survive branch changes. Search-console ownership and live CDN settings
also belong to deployment operations, not a source branch.

References: [Google indexing requirements](https://developers.google.com/search/docs/essentials/technical),
[Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features),
[Google crawler controls](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers#google-extended),
[OpenAI crawlers](https://developers.openai.com/api/docs/bots),
[Anthropic crawlers](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler).
