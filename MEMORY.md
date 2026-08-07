# Project Memory

## Device Tracking map work

- Added Leaflet marker clustering for nearby users. Clusters zoom into their members and spiderfy at maximum zoom.
- Added selectable map layers: Standard OpenStreetMap, Esri Satellite, OpenTopoMap Terrain, and CARTO Dark.
- Added route modes for driving, walking, and cycling. Driving uses the public OSRM endpoint; walking and cycling use the matching OpenStreetMap routing profiles, with a direct-line fallback when routing fails.
- Restored the professional default Leaflet pin marker after testing and rejecting a cartoon-style custom marker design.
- Added clickable room-member sidebar rows that center the map and open the selected marker popup.
- Added Locate me and Fit all users map actions.
- Added shared temporary landmarks. Clicking the map in a joined room prompts for a label and broadcasts the pin to the room through Socket.IO.
- Landmark pins show their label and creator, support Route here using Car/Walk/Cycle choices, and can only be removed by their creator. Server-side creator validation is enforced.
- Added landmark acknowledgement/error handling so failed pin creation is reported in the status bar. Landmark state is cleared when changing rooms or when the room becomes empty.
- Improved landmark popup spacing, route-mode controls, and creator-only removal button styling.
- Added responsive collapsible panels for room members, room controls, and chat. Collapse buttons are intended only for phone-sized screens (up to 720px).
- Simplified the chat header to one static Room chat row with a mobile-friendly collapse button; removed duplicate dynamic chat-header creation.
- Fullscreen map mode was prototyped and then removed at the user’s request. Do not re-add it unless explicitly requested.

## Documentation and validation

- Updated `README.md` and `CLAUDE.md` alongside the feature changes.
- `node --check app.js` and `node --check public/js/script.js` pass after the latest changes.
- `npm test` previously hung in the environment, so direct Node syntax checks were used for verification.

## Files commonly changed

- `app.js`: room landmark storage, synchronization, creation/removal events, creator authorization.
- `public/js/script.js`: map layers, clustering, routes, landmarks, controls, responsive panel behavior.
- `public/css/style.css`: popup, landmark, mobile control, and collapsible panel styling.
- `views/index.ejs`: Leaflet cluster assets and static chat header.
- `README.md`, `CLAUDE.md`: feature and architecture documentation.
- Made Show route and Route here toggle to Hide route, allowing route traces to be cancelled without a page refresh.
