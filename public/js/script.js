const socket = io();
const statusElement = document.getElementById("status");

function setStatus(message) {
    if (statusElement) {
        statusElement.textContent = message;
    }
}

function isValidCoordinate(latitude, longitude) {
    return (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180
    );
}

function formatDistance(meters) {
    if (!Number.isFinite(meters)) {
        return "";
    }

    if (meters >= 1000) {
        return `${(meters / 1000).toFixed(2)} km`;
    }

    return `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) {
        return "";
    }

    const minutes = Math.round(seconds / 60);

    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours} hr ${remainingMinutes} min`;
    }

    return `${minutes} min`;
}

const map = L.map("map").setView([0, 0], 2);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const markers = {};
const userLocations = {};
let currentLocation = null;
let selectedTargetId = null;
let routeLayer = null;
let routeUpdateTimer = null;
let hasCenteredMap = false;

function clearRoute() {
    selectedTargetId = null;

    if (routeUpdateTimer) {
        clearTimeout(routeUpdateTimer);
        routeUpdateTimer = null;
    }

    if (routeLayer) {
        map.removeLayer(routeLayer);
        routeLayer = null;
    }
}

function drawDirectPath(targetLocation) {
    if (routeLayer) {
        map.removeLayer(routeLayer);
    }

    routeLayer = L.polyline(
        [
            [currentLocation.latitude, currentLocation.longitude],
            [targetLocation.latitude, targetLocation.longitude],
        ],
        {
            color: "#2563eb",
            dashArray: "8 10",
            weight: 5,
        }
    ).addTo(map);

    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    setStatus("Routing service unavailable. Showing direct shortest path.");
}

async function drawRouteToSelectedUser() {
    const targetLocation = userLocations[selectedTargetId];

    if (!currentLocation) {
        setStatus("Waiting for your location before routing.");
        return;
    }

    if (!targetLocation) {
        clearRoute();
        setStatus("Selected user is no longer available.");
        return;
    }

    const start = `${currentLocation.longitude},${currentLocation.latitude}`;
    const end = `${targetLocation.longitude},${targetLocation.latitude}`;
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson`;

    try {
        setStatus("Finding shortest path...");
        const response = await fetch(routeUrl);

        if (!response.ok) {
            throw new Error("Route request failed");
        }

        const result = await response.json();
        const route = result.routes && result.routes[0];
        const coordinates = route && route.geometry && route.geometry.coordinates;

        if (!Array.isArray(coordinates) || coordinates.length === 0) {
            throw new Error("Route not found");
        }

        const latLngs = coordinates.map(([longitude, latitude]) => [latitude, longitude]);

        if (routeLayer) {
            map.removeLayer(routeLayer);
        }

        routeLayer = L.polyline(latLngs, {
            color: "#2563eb",
            weight: 5,
            opacity: 0.9,
        }).addTo(map);

        map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
        setStatus(
            `Shortest path: ${formatDistance(route.distance)} - ${formatDuration(route.duration)}`
        );
    } catch (error) {
        console.error(error);
        drawDirectPath(targetLocation);
    }
}

function scheduleRouteUpdate() {
    if (!selectedTargetId) {
        return;
    }

    if (routeUpdateTimer) {
        clearTimeout(routeUpdateTimer);
    }

    routeUpdateTimer = setTimeout(() => {
        routeUpdateTimer = null;
        drawRouteToSelectedUser();
    }, 1200);
}

function routeToUser(id) {
    if (id === socket.id) {
        setStatus("That pin is your current location.");
        return;
    }

    selectedTargetId = id;
    drawRouteToSelectedUser();
}

function bindMarkerPopup(id, marker) {
    const popupContent = document.createElement("div");
    popupContent.className = "marker-popup";

    const label = document.createElement("div");
    label.className = "marker-title";
    label.textContent = id === socket.id ? "You" : "Tracked user";
    popupContent.appendChild(label);

    if (id !== socket.id) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "route-button";
        button.textContent = "Shortest path";
        button.addEventListener("click", () => routeToUser(id));
        popupContent.appendChild(button);
    }

    marker.bindPopup(popupContent);
}

if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;

            if (!isValidCoordinate(latitude, longitude)) {
                setStatus("Ignoring invalid location update.");
                return;
            }

            currentLocation = { latitude, longitude };
            socket.emit("send-location", { latitude, longitude });

            if (selectedTargetId) {
                scheduleRouteUpdate();
            } else {
                setStatus("Sharing your live location");
            }
        },
        (error) => {
            console.error(error);
            setStatus(`Location error: ${error.message}`);
        },
        {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0,
        }
    );
} else {
    setStatus("Geolocation is not supported by this browser");
}

socket.on("receive-location", (data) => {
    const { id, latitude, longitude } = data;

    if (!isValidCoordinate(latitude, longitude)) {
        return;
    }

    userLocations[id] = { latitude, longitude };

    if (!hasCenteredMap && id === socket.id) {
        map.setView([latitude, longitude], 16);
        hasCenteredMap = true;
    }

    if (markers[id]) {
        markers[id].setLatLng([latitude, longitude]);
    } else {
        markers[id] = L.marker([latitude, longitude]).addTo(map);
        bindMarkerPopup(id, markers[id]);
    }

    if (id === selectedTargetId || id === socket.id) {
        scheduleRouteUpdate();
    }
});

socket.on("user-disconnected", (id) => {
    delete userLocations[id];

    if (markers[id]) {
        map.removeLayer(markers[id]);
        delete markers[id];
    }

    if (id === selectedTargetId) {
        clearRoute();
        setStatus("Selected user disconnected.");
    }
});

socket.on("connect", () => {
    setStatus("Connected. Waiting for location...");
});

socket.on("disconnect", () => {
    setStatus("Disconnected from tracking server");
});
