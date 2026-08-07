# Realtime Device Tracking

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Repo Size](https://img.shields.io/github/repo-size/iamabirakash/Realtime-Tracking)](https://github.com/iamabirakash/Realtime-Tracking) [![Built with Leaflet](https://img.shields.io/badge/leaflet-1.9.4-brightgreen)](https://leafletjs.com/)

A modern, lightweight web app for sharing live device locations inside short-lived rooms. Team up with friends or colleagues and watch locations update in real time on an interactive map.

Demo: (Self-hosted) — run locally and open the same room from multiple devices to see live updates.

---

Highlights
- Real-time room-based location sharing (per-room member list)
- Beautiful, responsive Leaflet map with multiple base layers (Standard, Satellite, Terrain, Dark)
- Clustered markers and polished member pins
- “Locate me” and “Fit all users” actions for quick navigation
- Lightweight in-memory server for small demos and internal use (no DB required)
- Click-to-create shareable temporary landmarks with creator-only removal
- Simple room invites and integrated chat for quick coordination
- Routing options (Driving / Walking / Cycling) using public routing services

Screenshots

<img width="1920" height="899" alt="image" src="https://github.com/user-attachments/assets/11350cd1-ddb4-4d8e-b4de-16d4db54ce35" />


- Map with clustered members and sidebar
- Landmark popup with route actions

---

Quick start

Prerequisites
- Node.js (v16+ recommended)

Install

```bash
npm install
```

Run

```bash
npm start
```

By default the app listens on port 3000. To change the port, set the PORT environment variable, for example:

```bash
PORT=8080 npm start
```

How it works (short)
- Open the app and create a room or join an existing room using a room code/link.
- Enter a display name and allow location access in the browser.
- Your device will periodically send location updates to the room via WebSocket.
- Other room members will see your location update on their maps in real time.
- Click the map to add a temporary landmark (shareable link) — the landmark creator can remove it.

Configuration & Notes
- No database: room state and locations are kept in server memory. Restarting the server will clear rooms and landmarks.
- Map tiles and routing: this project uses public OpenStreetMap ecosystem tile servers and routing providers. Availability and rate limits are out of scope — consider adding your own tile/routing keys/services for production.
- Privacy: location sharing is ephemeral and intended for short-lived coordination. The server does not persist location history by default.

Environment variables
- PORT — the HTTP port to bind (defaults to 3000)
- (Optional) Add keys/config for third-party providers if you choose to use paid map or routing providers in production.

Security
- This project is intended for local/demo use. If deploying publicly:
  - Terminate TLS (run behind a reverse proxy or use a platform that provides HTTPS).
  - Add authentication/authorization if rooms should be private beyond the invite link.
  - Replace in-memory room storage with a persistent store if you need durability.

Development
- Code is primarily JavaScript, with EJS templates and CSS for the front end.
- Live reloading tip: use nodemon for a faster local development loop:

```bash
npm install -g nodemon
nodemon --watch . --exec "npm start"
```

Project structure (high level)
- public/ — static frontend assets (JS, CSS, images)
- views/ — EJS templates used to render the main UI
- server.js (or app entry) — Express + Socket.io server logic

Contributing
- Bug reports, feature requests and pull requests are welcome.
- Start by opening an issue describing what you want to change, or submit a PR against the default branch with a clear commit message and description.

Troubleshooting
- If devices cannot see each other on localhost, ensure all clients are on the same network and the server host is reachable (use the machine’s LAN IP rather than `localhost` for other devices).
- If map tiles fail to load, check browser console for CORS or rate-limit errors from the tile provider.

FAQ
- Q: Do I need API keys for routing?  
  A: No — the project uses public routing endpoints. For production you may want to configure a paid routing provider or a personal API key to avoid rate limits.

Credits & Acknowledgements
- Built with Leaflet, MarkerCluster and OpenStreetMap tiles.
- Icons and UI design inspired by common modern mapping apps.

License
- MIT — see the LICENSE file for details.

Contact
- Maintainer: @iamabirakash
- Issues: https://github.com/iamabirakash/Realtime-Tracking/issues
