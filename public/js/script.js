const socket = io();
const statusElement = document.getElementById("status");

function setStatus(message) {
    if (statusElement) {
        statusElement.textContent = message;
    }
}

const map = L.map("map").setView([0, 0], 2);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            socket.emit("send-location", { latitude, longitude });
            setStatus("Sharing your live location");
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

const markers = {};
let hasCenteredMap = false;

socket.on("receive-location", (data) => {
    const { id, latitude, longitude } = data;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return;
    }

    if (!hasCenteredMap && id === socket.id) {
        map.setView([latitude, longitude], 16);
        hasCenteredMap = true;
    }

    if (markers[id]) {
        markers[id].setLatLng([latitude, longitude]);
    } else {
        markers[id] = L.marker([latitude, longitude]).addTo(map);
    }
});

socket.on("user-disconnected", (id) => {
    if (markers[id]) {
        map.removeLayer(markers[id]);
        delete markers[id];
    }
});

socket.on("connect", () => {
    setStatus("Connected. Waiting for location...");
});

socket.on("disconnect", () => {
    setStatus("Disconnected from tracking server");
});
