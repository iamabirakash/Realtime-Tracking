# Review remediation

The findings in `PROJECT_REVIEW.md` describe the pre-fix checkout. This document maps each finding to the current implementation. Existing styling and the Pingroom design were retained while room state and security boundaries were rebuilt.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Socket payload crash | All socket events reject non-object/null/array payloads and validate fields before use; regression-tested. |
| 2 | Tooltip XSS | Display names enter tooltip/popup DOM through textContent; self-only script CSP blocks inline handlers as an additional boundary. |
| 3 | Unlimited resource use | Connection, session, room, member, pin, payload, event and history caps; TTL cleanup; coalesced/volatile position updates. |
| 4 | Incorrect room cleanup | Explicit member sets, separate position availability, cleanup by membership, bounded disconnect grace and room lifetime. |
| 5 | Invite protection | Server-generated 64-bit random room codes with collision checking, separate Create/Join, expiry and creator-only close/revocation. Invite possession intentionally grants room access. |
| 6 | Origins/headers | Handshake Origin checks, configured polling CORS, Helmet CSP/framing/referrer headers and Permissions-Policy. |
| 7 | Old dependencies | Updated direct dependencies and compatible transitive patches; dependency-free EJS 7 removes the old build-tool chain. |
| 8 | Ghost state on reconnect | Stable server-issued member sessions; clear offline presentation and replace state from authoritative snapshots. |
| 9 | Pin ownership lost | Ownership uses verified member identity, not transport socket ID; acknowledged removal failures. |
| 10 | Offline GPS buffering | Connected/joined checks, volatile position events, stopped watches during disconnect and fresh publication after resync. |
| 11 | Route races | AbortController, generation checks, timeout, validated geometry and cancelled stale results; regression-tested. |
| 12 | Old pin cache retained | Room reset clears both data Maps and all rendered layers; snapshot reconciliation deletes missed removals. |
| 13 | Create/Join ambiguity | Explicit server actions, strict complete-code validation, unknown-room rejection; Create ignores any existing invite code. |
| 14 | Members invisible without GPS | Explicit membership includes paused and temporarily disconnected users; GPS only controls markers. |
| 15 | Missing coordinates coerced to zero | Numeric-type checks before finite/range validation; accuracy/timestamp contract; regression-tested. |
| 16 | Accuracy/freshness absent | Accuracy and sample/receive timestamps, presence captions, stale-marker removal and expiry. |
| 17 | GPS consent/lifecycle | Opt-in sharing, no automatic invite join, pause control, retained watch ID and cleanup on pause/leave/disconnect/page exit. |
| 18 | Storage blocks startup | Guarded optional storage with in-memory fallback; room success independent of persistence. |
| 19 | Counts/avatars/live status | Membership-derived counts, avatar controls and explicit connection/sharing states. |
| 20 | Accessibility | Real member buttons/labels, tab roles and arrow keys, menu keyboard behavior, inert/hidden onboarding and collapsed content. |
| 21 | Sheet gestures | Handle owns pointer capture/move/release, both directions supported, drag starts from actual sheet state, content remains natively scrollable. |
| 22 | Chat loss | Delivery acknowledgements/timeouts, preserved draft and status, idempotent retry IDs, bounded replay on reconnect. |
| 23 | Misleading fallback | Dashed line explicitly labelled a straight-line estimate, not a travel route; provider data flow disclosed and URLs configurable. |
| 24 | Syntax-only tests | Node integration/routing suite, Chromium browser/layout/accessibility suite, CI for Node 22/24/26. |
| 25 | Process-local scaling | Explicit supported single-process/replica deployment, worker startup guard, health probe and shutdown. Shared-store horizontal scaling is deliberately outside this ephemeral deployment model. |
| 26 | Insecure LAN deployment | Secure-context detection with actionable UI, HTTPS instructions and Caddy/Docker deployment example. A domain/certificate setup is still required to host publicly. |
| 27 | Manifest | Named application and correct /images/ icon paths; no offline capability claimed. |
| 28 | Tracked dependencies | Removed node_modules from Git's index while keeping local files; npm ci + lockfile and ignore rules. |
| 29 | Documentation/license | Accurate privacy/lifetime/PIN/runtime documentation, MIT license file, app.js structure and narrower ignore rules. |

## Responsive implementation

Fluid widths, wrapping inputs, bounded dialogs, scrolling content, safe-area insets, dynamically measured sheet height, ResizeObserver/window/visualViewport updates, visible map attribution, touch-sized controls and a height-aware landscape layout. The page uses a bottom sheet below 900px and adjacent dock at wider widths.

Automated viewport matrix: 240, 280, 320, 360, 390, 414, 480, 600, 768, 899, 900, 1024, 1280, 1440, 1920, 2560, and 3840 pixels; additional 640×360, 844×390, 900×540, and 1280×400 layouts. These representative checks support a fluid layout; they are not a claim to have tested every physical device or browser.

## Verification

Completed verification on 2 November 2026:

- `npm test`: 18 regression tests passed, plus syntax checks.
- `npm run test:browser`: passed room/XSS/sharing/delivery/reconnect/ownership/storage checks, both sheet drag directions, menu access and 21 viewport configurations. Zero WCAG 2 A/AA and WCAG 2.1 AA violations in the tested onboarding, desktop-room and phone-room states.
- Live registry `npm audit --json --offline=false --registry=https://registry.npmjs.org`: zero vulnerabilities.
- Real-map screenshot pass: 69 successful map tile responses and no unhandled browser errors; desktop, phone and expanded-phone images saved in `test-results/`.
- `docker compose config --quiet`: passed with an example domain. The image was not deployed and public certificate issuance was not attempted.
- Working-tree source whitespace checks passed. Local installed dependencies remain available after Git index cleanup.

Run `npm test`, `npm run test:browser`, and `npm audit`. Browser screenshots, accessibility output and summary are generated under `test-results/`. Browser GPS and external map tiles are deterministic test inputs; production routing/provider availability, public certificate issuance, and real background GPS behavior are separate operational checks.
