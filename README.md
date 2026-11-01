# Pingroom / Device Tracking

Temporary, invite-based rooms for live locations, room chat, shared pins, and optional driving/walking/cycling directions. Express, Socket.IO, Leaflet, EJS, and vanilla JavaScript. No account or database is required.

## Run locally

Use Node.js 24 LTS (Node 22–26 supported). The repository includes `.nvmrc` and a lockfile.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. For a different port in PowerShell:

```powershell
$env:PORT = "8080"
npm start
```

Create a room with a display name, or join an existing room using its 16-character code or invite link. Create always makes a new room. Unknown/expired codes are rejected. Invite links prefill the code and require an explicit Join action.

Location sharing starts only when you check **Share my location when I join**, or press **Share location** inside the room. **Pause sharing** stops the device watch and removes the shared position. Members can participate in chat without sharing their location and remain visible in the member list.

Anyone holding an invite can join and see that room's shared positions and recent chat. There is no PIN feature. Protect the link as an access secret; the room creator can close the room for everyone from the profile menu.

## HTTPS and phones

Browser geolocation requires a secure context. Localhost supports development on the same computer, but a phone visiting another computer's plain `http://192.168...` address normally cannot share location. Use a trusted HTTPS development proxy/tunnel or an HTTPS deployment. The app explains insecure-context and permission errors and still supports rooms/chat without GPS.

The layout uses a collapsible bottom sheet below 900px and a docked sidebar above it. It adapts to width, viewport height, touch gestures, safe areas, and viewport resizing. Browser layout checks cover 240–3840px plus short/landscape layouts. Physical devices and background GPS reliability require separate validation; browsers may suspend background pages.

## Data and lifecycle

- Rooms are stored **only in one server process**, expire after 2 hours, and are deleted immediately when the last member explicitly leaves or the creator closes the room.
- Unexpected disconnections get a 30-second reconnect window (cleanup runs every 5 seconds). Their live position is removed immediately. Reconnection replaces client state from an authoritative snapshot.
- Pins expire after 1 hour or at room expiry, whichever comes first. Only their creator can remove them; ownership survives reconnects using a server-issued member session.
- Up to 100 recent messages are kept in memory per room and replayed after reconnect. Older messages are discarded. There is no permanent location or chat archive.
- The last display name is remembered in localStorage. A random member credential is stored in sessionStorage for the tab; blocked storage falls back to in-memory operation. Anonymous server session records expire after 3 hours of inactivity after disconnection.
- Map tile requests go directly to OpenStreetMap, Esri, OpenTopoMap, or CARTO. Requested routes send start/destination coordinates to the selected routing provider. The app does not upload coordinates to a routing provider until a route is requested.
- The map libraries are served locally; an external JavaScript CDN is not needed. Map tiles and directions still require provider availability. A failed route is labelled a **straight-line estimate, not a travel route**.
- Restarting the server clears room data. If a restart loses a room, clients must create a new one; the app does not silently recreate an expired invite.

## Limits and security

The server validates every event payload, uses cryptographically generated room/session identifiers, enforces creator permissions, sets browser security headers, checks WebSocket origins, caps request sizes, and applies per-member/IP event budgets.

Defaults in `server/tracking-server.js`:

| Resource | Limit |
| --- | --- |
| Rooms | 200 |
| Members per room | 50 |
| Pins per room | 100 |
| Recent chat messages per room | 100 |
| Transport connections | 1,000 total; 40 per directly connected IP |
| Member-session records | 10,000 |
| Incoming socket message | 8 KiB |
| Join attempts | 12 per member session per minute |
| GPS events | 20 per member session per 10 seconds; client coalesces to one per 3 seconds |
| Chat sends | 20 per member session per 10 seconds |
| Pin creation | 10 per member session per minute |
| Position freshness | 60 seconds |

Browser-reported positions are not verified proof of physical presence. Use HTTPS and infrastructure-level connection/request limits for public deployments. The app does not trust arbitrary forwarded IP headers; behind the supplied proxy, clients share the proxy's IP quota. Tune edge quotas and the application limits for your expected room sizes rather than blindly trusting `X-Forwarded-For`.

## Configuration

`.env.example` lists values; Node reads real environment variables, not that file automatically.

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port, default 3000 |
| `HOST` | Bind address, default 0.0.0.0 |
| `NODE_ENV` | Set to `production` behind HTTPS |
| `ALLOWED_ORIGINS` | Comma-separated exact public origins, e.g. `https://pingroom.example.com`; required in production |
| `WEB_CONCURRENCY` | Must be 1 for the supported ephemeral store |
| `ROUTING_DRIVING_URL` | Optional HTTPS OSRM-compatible route endpoint |
| `ROUTING_WALKING_URL` | Optional HTTPS foot-routing endpoint |
| `ROUTING_CYCLING_URL` | Optional HTTPS bike-routing endpoint |

Without an explicit origin list in development, only browser origins whose host matches the request host are accepted. Native clients without an Origin still need a valid invite and obey the same limits.

## Deployment

Run **one worker and one replica**. The process-local room store is intentional. Do not use PM2 cluster mode or multiple replicas: a Socket.IO adapter alone cannot synchronize the application's Maps. A future horizontal deployment needs both shared ephemeral room/session state with TTL and an appropriate Socket.IO adapter.

`Dockerfile`, `compose.yml`, and `Caddyfile` provide a single app process behind Caddy HTTPS. Point a public domain at your server, allow ports 80/443, then:

```powershell
$env:PINGROOM_DOMAIN = "pingroom.example.com"
docker compose up --build -d
```

Use a real domain you control. Caddy obtains certificates for that domain; no deployment or certificate issuance is performed by editing this repository. `/healthz` returns readiness; SIGTERM/SIGINT stop connections and clear in-memory state. Set `ALLOWED_ORIGINS` explicitly when using a different reverse proxy, and preserve its Host header.

## Verification

```sh
npm test
npx playwright install chromium
npm run test:browser
npm audit
```

- `npm test`: syntax checks and server/routing regression tests using isolated local servers.
- `npm run test:browser`: Chromium room, consent, XSS, delivery, reconnect, ownership, optional-storage, accessibility, and responsive-layout checks. Uses synthetic GPS and deterministic tile responses; saves screenshots and results under ignored `test-results/`.
- The browser suite tests the real local JavaScript, CSS, Socket.IO server, and templates. It does not certify external routing availability or physical-device GPS.
- GitHub Actions runs server tests on Node 22/24/26, audits dependencies, and runs Chromium checks on Node 24.

## Files

- `app.js`: validated startup, single-worker guard, graceful shutdown.
- `server/tracking-server.js`: room/member/session model, validation, event authorization, limits, cleanup, security headers.
- `public/js/script.js`: map, rooms, opt-in sharing, chat, snapshots, responsive sheet and accessibility behavior.
- `public/js/route-controller.js`: cancellable routing lifecycle.
- `views/app.ejs`, `views/index.ejs`, `public/css/style.css`: application and landing-page presentation.
- `test/`, `scripts/check-browser.cjs`: regression suites.
- `PROJECT_REVIEW.md`: historical findings; `REMEDIATION.md`: implementation and verification mapping.

MIT licensed. See [LICENSE](LICENSE). Third-party packages and map data retain their respective licenses and attribution requirements.
