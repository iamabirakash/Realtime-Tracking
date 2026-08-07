# Device Tracking

A real-time location-sharing web app. Users join a room and share their live device locations with other room members.

## Features

- Live room-based device location sharing with named members.
- Professional Leaflet pin markers for room members.
- Marker clustering for nearby devices.
- Click a member in the sidebar to center the map and open their marker.
- Map styles: Standard, Satellite, Terrain, and Dark.
- Map actions: Locate me and Fit all users.
- Route options to another member for driving, walking, or cycling.
- Click the map to create shareable temporary landmarks for the room; creators can remove their own pins.
- Room invite links and real-time room chat.

## Prerequisites

Install [Node.js](https://nodejs.org/en/download/package-manager/current).

## Installation

```bash
npm install
```

## Running the server

```bash
npm start
```

The app runs on port `3000` by default. Set the `PORT` environment variable to use another port.

## Notes

- Devices should be connected to the same network when using a local server.
- Location updates are sent whenever the browser geolocation watcher reports a change.
- Map tiles and routing use public OpenStreetMap ecosystem services; availability and rate limits may vary.
- Room and location state is stored in memory and is lost when the server restarts.
- Landmark creation returns a server acknowledgement so invalid or failed pins show an error in the status bar.
- Every shared landmark includes a Route here action so all room members can navigate to it.
