# Device Tracking / Pingroom project review

**Historical review:** the findings below describe the checkout before remediation. Implementation changes and verification are mapped in [REMEDIATION.md](REMEDIATION.md). The original evidence and source line references below are retained for context and may no longer match the current files.

Reviewed: 2 November 2026. Scope: the current working copy, including existing uncommitted changes in the application, templates, styles, package files, assets, and documentation. Generated dependencies and the separate `.claude/worktrees` checkout were excluded from application-source review. No application code was changed.

This is a list of findings from source review and targeted checks, not a guarantee that no other defects exist. Severity assumes the app may be reachable by people outside a trusted local demo. Deployment gaps are identified separately from demonstrated bugs.

## What was verified

- `npm test` passes, but it only checks JavaScript syntax.
- The app starts and `/app` loads in headless Chromium without initial JavaScript errors. Room creation, location publication, and a second socket joining were exercised.
- An unauthenticated `join-room` event containing `null` terminated an isolated server with exit code 1. Other handlers also threw on `null` in an isolated handler harness.
- A second client joined with the display name `<img src=x onerror=xss=1>`. Opening its visible map tooltip executed the handler in the receiving browser: `window.xss === 1`.
- Room cleanup tests reproduced both premature deletion and orphaned landmark retention.
- Reconnecting reproduced an old self marker remaining beside the new socket identity.
- A deferred routing-response test reproduced a route being drawn after `clearRoute()`.
- Two located members still displayed `1 here`; the avatar row remained empty.
- Publishing one location after disconnection added one event to the Socket.IO outgoing buffer.
- Blocking browser storage caused an uncaught `SecurityError` and left Create disabled.
- An invisible onboarding input remained focusable after joining.
- A WebSocket handshake with an unrelated Origin was accepted.
- Manifest icon URLs returned 404, while their `/images/` equivalents returned 200.
- The two existing Leaflet integrity hashes match the fetched CDN files. Those hashes are not a defect.
- `npm audit --json` returned zero findings in this environment. Installed versions were also compared with upstream security documentation; the zero result should not be treated as a clean bill of health.

## Findings and fixes

### 1. High: an unauthenticated client can crash the server

**Location:** `app.js:102`, `143`, `168`, `197`, `212`.

The handlers use `data = {}`, which only supplies a default for `undefined`. A caller can send `null`, after which property access throws. `join-room` is reachable before joining any room; the live reproduction crashed at `data.displayName` on line 103. A crash also destroys all in-memory rooms.

**Fix:** Validate every event's payload before accessing it: require a non-null, non-array object, then validate each field's type and bounds. Return a consistent validation acknowledgement. Contain unexpected handler errors and log them without recording sensitive coordinates. A global uncaught-exception handler is not a substitute for fixing the handlers.

**Regression check:** Send null, arrays, strings, missing fields, and wrong field types to every event. Verify the process stays alive and other clients remain usable.

### 2. High: display names allow cross-site scripting through map tooltips

**Location:** `public/js/script.js:543`; display-name acceptance at `app.js:21`.

`bindTooltip(tooltipText)` and `setTooltipContent(tooltipText)` receive an untrusted string. Leaflet renders string tooltip content as HTML. Trimming and limiting a name to 30 characters does not make it safe: the reproduced payload fits within the limit. Another room member can execute JavaScript when the tooltip opens, with access to that page's room and location state.

**Fix:** Create an element, assign the name through `element.textContent`, and pass the element to both tooltip methods. Apply the same rule to future popup or tooltip content. Add a restrictive Content Security Policy as defense in depth.

**Regression check:** Use names containing tags and event attributes; verify they appear literally and execute nothing. [Leaflet documents this HTML behavior and the textContent approach.](https://leafletjs.com/reference.html#tooltip)

### 3. High: socket events and retained state have no application limits

**Location:** `app.js:102`, `143`, `168`, `212`; `public/js/script.js:1193`.

There are no per-socket or per-room limits on join attempts, location update frequency, chat frequency, room size, or landmark count. Pins accumulate in server memory; every incoming chat message appends another DOM subtree. Even bounded individual strings do not bound total memory, bandwidth, or rendering work. This is an abuse risk established by source review; a destructive load test was not run.

**Fix:** Add per-IP connection/join limits and per-member event budgets, a room-member cap, a pin cap and expiry, and a bounded chat window. Limit incoming payload size to actual needs. Coalesce location updates and drop redundant positions. Enforce these limits server-side and return useful errors.

### 4. High: room cleanup uses located users instead of actual membership

**Location:** `app.js:61`, `87`, `129`, `164`.

The server decides a room is empty by checking the location map. Two failures were reproduced:

1. Alice and Bob join; only Alice publishes a location. Alice leaves. Both room maps are deleted even though Bob is still connected. Bob receives no landmark deletion event, so his view disagrees with the server and later joiners.
2. After that deletion, Bob adds a pin without publishing a location and leaves. There is no location map to trigger cleanup, so the landmark map remains after the room is empty.

**Fix:** Maintain an explicit room record with a member set independent of coordinates. Remove membership on switch/disconnect, and clear room state only when membership is actually empty. Add expiry as a backstop. Synchronize any intentional clearing with remaining clients.

### 5. High for private public-facing rooms: room codes are weak access controls

**Location:** `app.js:13`, `29`, `37`, `117`.

Any normalized code of 3-32 characters is accepted, and knowing it grants access to the room's precise positions and chat. The server's fallback generator uses `Math.random()` and does not check for an existing room. There is no expiry, lock, revocation, or optional PIN enforcement. Anonymous rooms are an intentional feature; the risk is treating these codes as strong protection for private location sharing.

**Fix:** Generate room identifiers on the server with `node:crypto`, sufficient entropy, and collision checking. Distinguish room creation from joining an existing room. If short human-readable codes are needed, pair them with a stronger invite token or access secret and strict attempt limits. Add expiry and a way to close/revoke a room.

### 6. Medium: no explicit WebSocket origin policy or browser security headers

**Location:** `app.js:8`, `95`.

An unrelated WebSocket Origin was accepted. The HTTP response also lacked application-level CSP, framing restrictions, and Permissions-Policy. Cross-origin socket access expands browser-based abuse opportunities; no cookie-authenticated session hijacking was demonstrated because the app has no such session system.

**Fix:** Set an allowlist through Socket.IO's handshake authorization, such as `allowRequest`; configure polling CORS consistently. Origin checks supplement authorization and rate limits because non-browser clients can forge Origin. Add security headers, including a tested CSP, `frame-ancestors`, and a geolocation Permissions-Policy. Configure HSTS at the HTTPS terminator when appropriate.

### 7. Medium: the locked dependency tree predates published security fixes

**Location:** `package-lock.json:95`, `390`, `763`, `870`, `898`; `package.json:14`.

Installed examples include Express 4.19.2, path-to-regexp 0.1.7, body-parser 1.20.2, send 0.18.0, and serve-static 1.15.0. Upstream documents later security fixes. The current app has only literal Express routes and does not enable body-parser, so those particular ReDoS paths were not demonstrated reachable; package presence and current exploitability are different questions.

**Fix:** Update to maintained compatible releases, regenerate the lockfile, and verify the resolved transitive tree. If retaining the path-to-regexp 0.1 branch, upstream's March 2026 advisory identifies 0.1.13 as the patched version for its multiple-parameter issue. Do not force an incompatible major-version override into Express. Add dependency monitoring and investigate why the audit service returned no findings for this old tree.

Sources: [Express security updates](https://expressjs.com/en/advanced/security-updates/), [path-to-regexp upstream advisory](https://github.com/pillarjs/path-to-regexp/security/advisories/GHSA-37ch-88jc-xwx2).

### 8. Medium: reconnects retain ghost users and missed deletions

**Location:** `public/js/script.js:587`, `603`, `1121`, `1231`, `1241`.

Client state is reset only when the room code changes. Reconnecting to the same room gets a new socket ID and merges replayed positions into the old dictionaries. The old self marker remained in the browser reproduction. Users who left and pins deleted while the client was offline can also remain because there is no authoritative replacement snapshot.

**Fix:** Treat reconnection as a resynchronization. Replace members, locations, and landmarks from one versioned room snapshot; then apply subsequent events. Use stable server-verified member identities and mark old information as disconnected/stale while resync is pending. [Socket.IO documents that socket IDs change across reconnects.](https://socket.io/docs/v4/client-api/#socketid)

### 9. Medium: pin creators lose ownership after reconnection

**Location:** `app.js:183`, `205`; `public/js/script.js:361`, `425`.

Ownership is tied to `socket.id`. After reconnecting while other members remain, the creator has a new socket ID and cannot remove their old pin. Existing cached markers also skip rebuilding popup controls, which can leave a misleading enabled Remove button that the server rejects.

**Fix:** Bind ownership to a stable, server-verified room-member session. Reconcile popup permissions after resync. Acknowledge removal success and denial so the UI reports the real outcome. Do not trust an arbitrary client-supplied creator ID.

### 10. Medium: locations buffer while disconnected

**Location:** `public/js/script.js:457`, `1083`, `1241`.

`publishLocation()` checks for a room and position but not connection or confirmed rejoin state. Socket.IO buffers these emits while offline; the reproduction added one buffered event after disconnecting. An outage can accumulate positions that are replayed before room rejoin and discarded, or produce a needless burst. This also retains a temporary sequence of sensitive positions in client memory.

**Fix:** Publish only while connected and successfully joined. Keep just the newest position, use volatile sends for transient location updates where appropriate, and publish the latest sample after resync. Gate pin operations similarly. [Socket.IO's client API describes volatile delivery and disconnection behavior.](https://socket.io/docs/v4/client-api/)

### 11. Medium: stale route responses redraw cancelled or superseded routes

**Location:** `public/js/script.js:324`, `710`, `735`, `751`, `765`.

`clearRoute()` removes the current line and debounce timer, but cannot cancel an in-flight fetch. The deferred-response test cleared a route and then resolved its request; a new route layer appeared despite the selected target being null. Selecting a different target or switching rooms has the same race. There is also no request timeout.

**Fix:** Abort the previous request on clear, target change, room change, and disconnect. Use a monotonically increasing request generation and verify room, destination, mode, and generation before applying either success or fallback. Add a timeout. Aborted/stale requests must not draw fallback lines.

### 12. Medium: clearing landmark markers leaves landmark data behind

**Location:** `public/js/script.js:347`, `359`, `445`.

`clearLandmarks()` deletes rendered markers but never deletes entries from the separate `landmarks` object. Changing rooms therefore keeps old pin labels and coordinates in memory, grows the cache, and allows routing helpers to resolve stale entries.

**Fix:** Clear the data cache together with the layer and marker dictionary. Prefer one room-scoped state container that can be replaced atomically. Check that room switches remove every previous landmark from both data and presentation.

### 13. Medium: Create and Join do not reliably mean different actions

**Location:** `public/js/script.js:297`, `648`, `916`; `app.js:117`.

Join stays enabled with an empty/invalid code; the server silently creates a random room for that case. Any well-formed nonexistent code is also accepted without an existence check. Create reuses the room code already in the field, including an invite code, and can join an existing room instead of creating a new one. Stripping invalid characters can silently transform one input into another valid room code.

**Fix:** Define separate create and join operations. Create always generates a new server-side code; Join requires an existing valid room and returns a clear error otherwise. Normalize case/outer whitespace, but reject unexpected characters and overlong values rather than silently rewriting their meaning. Keep frontend validation consistent with the server contract.

### 14. Medium: connected members without a position are invisible

**Location:** `app.js:129`, `164`; `public/js/script.js:503`.

Only location publication populates member state and the list. Someone who denies geolocation can receive other people's positions and send chat messages while remaining absent from the member list. A slow GPS fix looks like a missing participant. This undermines the displayed participant list and awareness of who can observe the room.

**Fix:** Broadcast membership independently of position availability. Show all joined members with states such as waiting for location, sharing, paused, or disconnected. Render map markers only for members with usable positions.

### 15. Medium: coordinate validation accepts missing values as real coordinates

**Location:** `app.js:148`, `174`.

`Number(null)`, `Number('')`, and `Number(false)` all become zero. The handler test stored `{ latitude: null, longitude: '' }` as a valid position at `(0, 0)`. Invalid landmarks can be created in the same way. Numeric conversion and finite/range checks alone do not enforce the expected input contract.

**Fix:** Require JSON numeric fields with `typeof value === 'number'`, then apply finite/range checks. Validate optional accuracy and sample timestamp fields separately.

### 16. Medium: positions have no accuracy or freshness information

**Location:** `public/js/script.js:1083`; `app.js:162`.

The client discards `coords.accuracy` and the sample timestamp. A connected browser whose GPS stops updating remains displayed at its old position without any last-update or stale indication. Routes use that position as if it were current.

**Fix:** Carry validated accuracy and sample time, add a server receive time, display freshness/accuracy, and mark or expire stale samples. Treat client timestamps as untrusted metadata rather than authority. Label reported device locations appropriately; browser coordinates are not proof of physical presence.

### 17. Medium: location watching starts before joining and has no pause lifecycle

**Location:** `public/js/script.js:1083`, `1248`; `views/app.ejs:98`.

A high-accuracy watch starts as soon as `/app` loads, before a room is selected. Its watch ID is discarded, so the app cannot clear it while the page remains open. There is no pause-sharing control. With a saved display name, an invite URL automatically joins and begins publishing once browser permission exists, without a fresh in-app sharing confirmation.

**Fix:** Start watching after an explicit sharing action; retain the watch ID and stop it on pause/leave. Explain autojoin and sharing behavior, or require confirmation for a new room. Support reduced-accuracy/update-frequency options where useful. Browser background suspension also means continuous tracking cannot be guaranteed by this implementation.

### 18. Medium: blocked localStorage breaks initialization and joining

**Location:** `public/js/script.js:613`, `866`.

Storage calls are unguarded. When storage access was made to throw, script execution stopped at initialization, handlers below that point were never registered, and Create stayed disabled. A write failure during `finishRoomJoin()` can also interrupt onboarding completion after the server already accepted membership.

**Fix:** Wrap storage reads/writes in a small try/catch helper with in-memory fallback. Storage persistence should be optional, and room success should not depend on it.

### 19. Medium: the member count and avatar strip are disconnected from live state

**Location:** `views/app.ejs:32`, `74`; `public/js/script.js:503`.

`member-count` starts at 1 and is never updated; `avatar-row` is never populated. With two located members, the browser still showed `1 here` and zero avatars. The animated green live indicator also does not reflect disconnection.

**Fix:** Update count, avatars, and connection indicator from the explicit membership/connection model on join, leave, reconnect, and snapshot replacement. Show zero/waiting before joining and an offline state during outages.

### 20. Medium: keyboard and assistive-technology support is incomplete

**Location:** `public/js/script.js:509`; `views/app.ejs:36`, `65`, `75`, `84`, `102`; `public/css/style.css:584`.

Member rows are clickable `<li>` elements without keyboard controls. The name field's visible caption is a `<span>`, and room/chat fields lack persistent associated labels. Tabs do not expose tab roles, selection, or controlled panels. The profile menu does not expose expanded state or implement Escape/focus handling. The sheet handle starts with `aria-expanded="true"` while its state is `peek`. Hidden onboarding only changes opacity/pointer events; its input remained focusable in the browser check.

**Fix:** Use buttons inside member rows, proper `<label for>` elements, appropriate tab/menu semantics and keyboard behavior, and synchronized state attributes. Hide/inert inactive onboarding so it leaves the tab order and accessibility tree; move focus to an appropriate active control after joining.

### 21. Medium: the sheet drag handler captures pointers on the wrong element

**Location:** `public/js/script.js:1017`, `1043`, `1054`, `1068`; `public/css/style.css:284`.

Movement/release listeners are registered on `sheetHandle`, but pointer capture is set on its parent `sheetEl`. Captured events are retargeted to the parent, so the child listeners do not receive the normal subsequent sequence. The code additionally ignores negative drag deltas and reads only an inline transform, not the CSS transform of the collapsed state. These source-level problems prevent a consistent upward/downward drag model; physical-device gesture testing was not performed.

**Fix:** Capture and listen on the same element, derive the initial translation from computed state/transform, support both drag directions, and release capture on that same element. Restrict gesture interception and `touch-action: none` to the drag handle so content scrolling remains available.

### 22. Medium: chat clears the draft without delivery confirmation

**Location:** `public/js/script.js:952`, `970`; `app.js:212`.

Chat uses a fire-and-forget emit and immediately clears the field. A disconnect during send, server failure, or rejected message can lose the draft with no pending/failed indication. Reconnection has no chat replay or gap indication. Emptying the input is not evidence of delivery.

**Fix:** Add message IDs and acknowledgements with a timeout. Keep pending/failed UI and allow retry; deduplicate retries server-side. Explicitly document whether chat history is replayed, retained briefly in memory, or intentionally unavailable after interruption. Apply a bounded DOM window as described in finding 3.

### 23. Medium: routing fallback can be mistaken for usable directions

**Location:** `public/js/script.js:689`, `707`, `733`.

On any routing failure, the app draws a straight line and calls it a direct shortest path. That line ignores roads, barriers, water, and permitted travel modes. It should not be presented with wording that could imply a usable walking or driving route. Routing coordinates are also sent to external providers without an in-app explanation.

**Fix:** Label the fallback explicitly as a straight-line estimate with directions unavailable. Explain external routing data flow before the feature is used. Make routing endpoints configurable and handle unavailable providers with a clear retry state.

### 24. Medium engineering gap: there are no behavioral tests or automated regression gates

**Location:** `package.json:6`.

`npm test` aliases `node --check` for two files. It does not render EJS, exercise socket handlers, verify room isolation, or test the browser. Playwright is installed but has no checked-in suite/configuration. The existing command passes despite the crash and XSS reproductions.

**Fix:** Add a small server integration suite and focused browser checks. Prioritize malformed events, cross-room isolation, tooltip escaping, membership/cleanup, reconnect snapshots/ownership, route cancellation, blocked storage, and basic keyboard interaction. Add those checks to CI. Export app/server construction separately from listening so tests can use isolated ephemeral ports.

### 25. Medium deployment gap: storage and broadcasts are local to one process

**Location:** `app.js:8`, `10`, `11`.

The room maps and Socket.IO adapter are process-local. Multiple workers/replicas can show different members and landmarks for the same code. A restart drops every room, and reconnects silently recreate the code without restoring its state. In-memory operation is valid for the documented demo; it is a limitation if reliable multi-instance hosting is expected.

**Fix:** Either document and enforce single-instance ephemeral operation, or use shared room state with TTL and a compatible Socket.IO adapter. An adapter alone does not synchronize the application's Maps. Plan sticky sessions if retaining polling, graceful shutdown/drain, and a useful health endpoint.

### 26. Medium deployment/documentation gap: LAN HTTP instructions do not support normal phone geolocation

**Location:** `README.md:95`; `app.js:7`, `243`; `public/js/script.js:1083`.

The README suggests using the server's LAN IP while the server exposes HTTP. Geolocation requires a secure context; localhost's development exception does not generally apply to a phone browsing another machine's plain LAN IP. The page can load while its core location feature fails. A deployment proxy may already solve HTTPS, but no deployment configuration is supplied here.

**Fix:** Document and provide an HTTPS reverse-proxy or trusted HTTPS development setup. Detect `window.isSecureContext` and show actionable instructions when it is false. Distinguish denied permission, insecure context, timeout, and unsupported browser states. [Browser geolocation requirements are documented here.](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition)

### 27. Low: manifest icon paths are broken and app names are empty

**Location:** `public/images/site.webmanifest:1`; `views/app.ejs:19`.

The manifest points to `/android-chrome-192x192.png` and `/android-chrome-512x512.png`, but the files are served under `/images/`. The tested root icon URL returned 404. Both `name` and `short_name` are empty.

**Fix:** Set the correct `/images/...` paths, fill in the app names, and validate any intended install metadata. Do not imply offline/PWA support unless its required behavior is implemented and tested.

### 28. Medium repository gap: node_modules is committed despite being ignored

**Location:** `.gitignore:1`; Git tracked-file inventory.

Git tracks 1,101 files under `node_modules`. Ignore rules do not untrack existing files. This adds generated code and stale packages to source history, obscures dependency updates, and can make checked-out dependencies diverge from the lockfile or platform.

**Fix:** In a separate reviewed change, remove `node_modules` from Git's index while preserving local files, retain the ignore rule, and install from the committed lockfile with `npm ci`. Do not delete anyone's local dependency directory as part of index cleanup.

### 29. Low: documentation, ignore rules, and licensing disagree with the project

**Location:** `.gitignore:5`; `README.md:3`, `34`, `80`, `107`; `package.json:13`; `views/index.ejs:810`.

- The landing page advertises an optional PIN, but the UI/server implement no PIN.
- Broad claims that everything disappears need qualification: the display name is saved to localStorage, and the cleanup defects above can retain room landmarks.
- The README recommends Node 16+, but the project does not declare or enforce its tested runtime/tooling version.
- The README advertises MIT and links to a LICENSE file that is absent; package metadata says ISC.
- `.gitignore` ignores every new Markdown file, including new documentation and this report, unless explicitly added or excepted.
- The structure section refers ambiguously to `server.js`; the actual entry point is `app.js`.

**Fix:** Align product copy with implemented behavior, specify the server's actual retention/deletion policy, declare the supported/tested Node range, choose one intended license and include its text, and narrow Markdown ignore rules to specific private files.

## Recommended implementation order

1. Fix the server crash and tooltip XSS, then add focused regression tests for both.
2. Introduce an explicit room/member model, reliable cleanup, input schemas, and event/resource limits.
3. Implement authoritative reconnect snapshots and stable, server-verified ownership; stop offline location buffering.
4. Fix route cancellation, storage fallback, and separate Create/Join semantics.
5. Connect the remaining UI state, improve keyboard/gesture behavior, and clarify privacy/delivery status.
6. Update dependencies, remove generated dependencies from tracking, add CI, and finish the chosen HTTPS/deployment model and documentation.

## Review boundaries

No source fixes, dependency installation/upgrades, Git cleanup, deployment changes, or destructive load tests were performed. Existing user changes were preserved. Tests used synthetic coordinates and isolated local servers; no messages were sent to other people. The default map tiles loaded and routing code was reviewed, but every live provider/mode and real mobile background tracking were not certified. The gesture issue is based on source inspection, not a physical-device test.
