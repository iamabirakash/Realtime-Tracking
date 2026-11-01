"use strict";

// Kept independent of Leaflet so cancellation and races can be regression-tested.
function createRouteController({ onRoute, onClear, onStatus, request = fetch, timeoutMs = 10000 }) {
    let generation = 0;
    let active = null;
    function clear() {
        generation += 1;
        active?.abort();
        active = null;
        onClear();
    }
    async function calculate(origin, destination, endpoint) {
        clear();
        const version = generation;
        const controller = new AbortController();
        active = controller;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = `${origin.longitude},${origin.latitude}`;
        const end = `${destination.longitude},${destination.latitude}`;
        onStatus("Finding directions…");
        try {
            const response = await request(`${endpoint}/${start};${end}?overview=full&geometries=geojson`, { signal: controller.signal, referrerPolicy: "no-referrer" });
            if (!response.ok) throw new Error("Routing unavailable");
            const result = await response.json();
            const route = result.routes?.[0];
            const points = route?.geometry?.coordinates;
            if (!Array.isArray(points) || points.length < 2 || points.length > 100000
                || !points.every((point) => Array.isArray(point) && point.length >= 2
                    && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
                    && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90)) throw new Error("Invalid route");
            if (version !== generation || controller.signal.aborted) return;
            onRoute(points.map(([lng, lat]) => [lat, lng]), { direct: false, distance: route.distance, duration: route.duration });
        } catch {
            if (version !== generation) return;
            onRoute([[origin.latitude, origin.longitude], [destination.latitude, destination.longitude]], { direct: true });
            onStatus("Directions unavailable. Dashed line is a straight-line estimate, not a travel route.");
        } finally {
            clearTimeout(timer);
            if (version === generation) active = null;
        }
    }
    return { calculate, clear };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createRouteController };
