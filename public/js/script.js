const socket = io();
const statusElement = document.getElementById("status");
const statusText = document.querySelector("#status .status-text");
const roomForm = document.getElementById("room-form");
const displayNameInput = document.getElementById("display-name");
const roomCodeInput = document.getElementById("room-code");
const joinRoomButton = document.getElementById("join-room");
const createRoomButton = document.getElementById("create-room");
const copyRoomLinkButton = document.getElementById("copy-room-link");

function setStatus(message) {
    if (statusText) {
        statusText.textContent = message;
    } else if (statusElement) {
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

function normalizeRoomCode(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, "")
        .slice(0, 32);
}

function normalizeDisplayName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 30);
}

function isValidRoomCode(roomCode) {
    return /^[A-Z0-9_-]{3,32}$/.test(roomCode);
}

function isValidDisplayName(displayName) {
    return displayName.length >= 2 && displayName.length <= 30;
}

function generateRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ123456789";
    const bytes = new Uint8Array(8);

    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }

    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
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

const map = L.map("map", {
    zoomControl: false
}).setView([0, 0], 2);

const baseLayers = {
    "Standard": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
    }),
    "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles &copy; Esri",
        maxZoom: 19,
    }),
    "Terrain": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        attribution: "Map data &copy; OpenStreetMap contributors, SRTM | Map style &copy; OpenTopoMap",
        maxZoom: 17,
    }),
    "Dark": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        subdomains: "abcd",
        maxZoom: 20,
    }),
};

baseLayers.Standard.addTo(map);
L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(map);
L.control.zoom({ position: "topright" }).addTo(map);
function locateMe() {
    if (!currentLocation) {
        setStatus("Waiting for your location...");
        return;
    }

    map.setView([currentLocation.latitude, currentLocation.longitude], Math.max(map.getZoom(), 16));
    if (markers[socket.id]) {
        markers[socket.id].openPopup();
    }
    setStatus("Centered on your location.");
}

function fitAllUsers() {
    const locations = Object.values(userLocations)
        .filter((location) => isValidCoordinate(location.latitude, location.longitude))
        .map((location) => [location.latitude, location.longitude]);

    if (locations.length === 0) {
        setStatus("No shared locations are available yet.");
        return;
    }

    if (locations.length === 1) {
        map.setView(locations[0], Math.max(map.getZoom(), 16));
    } else {
        map.fitBounds(L.latLngBounds(locations), { padding: [60, 60], maxZoom: 16 });
    }
    setStatus(`Showing ${locations.length} room member${locations.length === 1 ? "" : "s"}.`);
}

const mapActions = L.control({ position: "topright" });
mapActions.onAdd = () => {
    const container = L.DomUtil.create("div", "leaflet-control map-actions");
    const locateButton = L.DomUtil.create("button", "map-action-button", container);
    locateButton.type = "button";
    locateButton.title = "Center on my location";
    locateButton.setAttribute("aria-label", "Center on my location");
    locateButton.textContent = "Locate me";
    locateButton.addEventListener("click", locateMe);

    const fitButton = L.DomUtil.create("button", "map-action-button", container);
    fitButton.type = "button";
    fitButton.title = "Show all room members";
    fitButton.setAttribute("aria-label", "Show all room members");
    fitButton.textContent = "Fit all";
    fitButton.addEventListener("click", fitAllUsers);

    L.DomEvent.disableClickPropagation(container);
    return container;
};
mapActions.addTo(map);
map.on("click", (event) => {
    if (!currentRoom) {
        setStatus("Join a room before adding a shared pin.");
        return;
    }

    const label = window.prompt("Landmark name (up to 50 characters):");
    if (!label || !label.trim()) {
        return;
    }

    socket.emit("add-landmark", {
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
        label: label.trim().slice(0, 50),
    }, (response = {}) => {
        if (!response.ok) {
            setStatus(response.error || "Could not add landmark.");
            return;
        }

        addLandmarkMarker(response.landmark);
        setStatus(`Landmark added: ${response.landmark.label}`);
    });
});

const markers = {};
const markerClusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    maxClusterRadius: 45,
}).addTo(map);
const landmarkMarkers = {};
const landmarks = {};
const landmarkLayer = L.layerGroup().addTo(map);
const userLocations = {};
let currentLocation = null;
let currentRoom = null;
let currentDisplayName = null;
let pendingRoom = null;
let joinTimeout = null;
let selectedTargetId = null;
let selectedLandmarkId = null;
let selectedRouteMode = "driving";
let routeLayer = null;
let routeUpdateTimer = null;
let hasCenteredMap = false;
let roomControlsBusy = false;

function updateJoinButtonState() {
    const displayName = normalizeDisplayName(displayNameInput && displayNameInput.value);
    const canUseName = isValidDisplayName(displayName);

    /* Join button is enabled as long as the name is valid –
       the room code can be empty (server will generate one) */
    if (joinRoomButton) {
        joinRoomButton.disabled = roomControlsBusy || !canUseName;
    }

    if (createRoomButton) {
        createRoomButton.disabled = roomControlsBusy || !canUseName;
    }
}

function setRoomControlsBusy(isBusy) {
    roomControlsBusy = isBusy;
    updateJoinButtonState();
}

function clearJoinTimeout() {
    if (joinTimeout) {
        clearTimeout(joinTimeout);
        joinTimeout = null;
    }
}

function clearRoute() {
    selectedTargetId = null;
    selectedLandmarkId = null;

    if (routeUpdateTimer) {
        clearTimeout(routeUpdateTimer);
        routeUpdateTimer = null;
    }

    if (routeLayer) {
        map.removeLayer(routeLayer);
        routeLayer = null;
    }
}

function clearMarkers() {
    Object.keys(markers).forEach((id) => {
        markerClusterGroup.removeLayer(markers[id]);
        delete markers[id];
        delete userLocations[id];
    });
}

function clearLandmarks() {
    Object.keys(landmarkMarkers).forEach((id) => {
        landmarkLayer.removeLayer(landmarkMarkers[id]);
        delete landmarkMarkers[id];
    });
}

function addLandmarkMarker(landmark) {
    if (!isValidCoordinate(landmark.latitude, landmark.longitude) || !landmark.id) {
        return;
    }

    landmarks[landmark.id] = landmark;

    if (landmarkMarkers[landmark.id]) {
        landmarkMarkers[landmark.id].setLatLng([landmark.latitude, landmark.longitude]);
        return;
    }

    const marker = L.marker([landmark.latitude, landmark.longitude]);
    const popupContent = document.createElement("div");
    popupContent.className = "landmark-popup";

    const title = document.createElement("strong");
    title.textContent = landmark.label;
    popupContent.appendChild(title);

    const creator = document.createElement("div");
    creator.className = "landmark-creator";
    creator.textContent = `Added by ${landmark.creatorName || "room member"}`;
    popupContent.appendChild(creator);

    const modeSelect = document.createElement("select");
    modeSelect.className = "landmark-route-mode";
    modeSelect.setAttribute("aria-label", "Travel mode");
    [
        ["driving", "Car"],
        ["walking", "Walk"],
        ["cycling", "Cycle"],
    ].forEach(([value, labelText]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = labelText;
        option.selected = value === selectedRouteMode;
        modeSelect.appendChild(option);
    });
    modeSelect.addEventListener("change", () => {
        selectedRouteMode = modeSelect.value;
    });
    popupContent.appendChild(modeSelect);

    const routeButton = document.createElement("button");
    routeButton.type = "button";
    routeButton.className = "route-button";
    routeButton.textContent = selectedLandmarkId === landmark.id ? "Hide route" : "Route here";
    routeButton.addEventListener("click", () => {
        if (selectedLandmarkId === landmark.id) {
            clearRoute();
            routeButton.textContent = "Route here";
            setStatus("Route cleared.");
            return;
        }
        routeToLandmark(landmark.id, modeSelect.value);
        routeButton.textContent = "Hide route";
    });
    popupContent.appendChild(routeButton);

    const removeButton = document.createElement("button");
    const isCreator = landmark.creatorId === socket.id;
    removeButton.type = "button";
    removeButton.className = "landmark-remove-button";
    removeButton.textContent = isCreator ? "Remove pin" : "Only creator can remove";
    removeButton.disabled = !isCreator;
    removeButton.title = isCreator ? "Remove this shared pin" : "Only the pin creator can remove it";
    if (isCreator) {
        removeButton.addEventListener("click", () => {
            socket.emit("remove-landmark", { id: landmark.id });
        });
    } else {
        removeButton.classList.add("landmark-remove-button--disabled");
    }
    popupContent.appendChild(removeButton);

    marker.bindPopup(popupContent);
    landmarkMarkers[landmark.id] = marker;
    landmarkLayer.addLayer(marker);
}
function resetTrackingView() {
    clearRoute();
    clearMarkers();
    clearLandmarks();
    updateUserList();
    hasCenteredMap = false;
    // Clear chat messages when leaving room
    if (chatMessages) {
        chatMessages.innerHTML = "";
    }
}

function publishLocation() {
    if (!currentRoom || !currentLocation) {
        return;
    }

    socket.emit("send-location", currentLocation);
}

function setRoomUrl(roomCode) {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    window.history.replaceState({}, "", url.toString());
}

function getInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", currentRoom);
    return url.toString();
}

async function copyInviteLink() {
    if (!currentRoom) {
        return;
    }

    const inviteLink = getInviteLink();

    try {
        await navigator.clipboard.writeText(inviteLink);
        setStatus(`Invite link copied for room ${currentRoom}.`);
    } catch (error) {
        console.error(error);
        window.prompt("Copy invite link", inviteLink);
    }
}

function getMarkerName(id) {
    if (id === socket.id && currentDisplayName) {
        return currentDisplayName;
    }

    return (userLocations[id] && userLocations[id].name) || "Room member";
}

/* ===== Sidebar: update the list of room members ===== */
function updateUserList() {
    const userList = document.getElementById("user-list");
    if (!userList) return;

    userList.innerHTML = "";

    Object.keys(userLocations).forEach((id) => {
        const li = document.createElement("li");
        li.className = "user-item";
        li.dataset.id = id;

        const name = getMarkerName(id);
        const isMe = id === socket.id;

        // Status dot
        const dot = document.createElement("span");
        dot.className = "user-dot" + (isMe ? " user-dot--me" : "");

        // Name text
        const nameSpan = document.createElement("span");
        nameSpan.textContent = isMe ? `${name} (you)` : name;

        li.addEventListener("click", () => {
            const location = userLocations[id];
            if (!location) return;
            map.setView([location.latitude, location.longitude], Math.max(map.getZoom(), 16));
            if (markers[id]) markers[id].openPopup();
        });

        li.appendChild(dot);
        li.appendChild(nameSpan);

        if (isMe) {
            li.classList.add("user-item--me");
        }

        userList.appendChild(li);
    });
}

function updateMarkerIdentity(id, marker) {
    const markerName = getMarkerName(id);
    const tooltipText = id === socket.id ? `You: ${markerName}` : markerName;

    if (marker.getTooltip()) {
        marker.setTooltipContent(tooltipText);
    } else {
        marker.bindTooltip(tooltipText, { direction: "top" });
    }

    bindMarkerPopup(id, marker);
}

function finishRoomJoin(roomCode, displayName) {
    const normalizedRoomCode = normalizeRoomCode(roomCode);
    const normalizedDisplayName = normalizeDisplayName(displayName || displayNameInput.value);

    if (!isValidRoomCode(normalizedRoomCode) || !isValidDisplayName(normalizedDisplayName)) {
        return;
    }

    const roomChanged = currentRoom !== normalizedRoomCode;

    clearJoinTimeout();
    pendingRoom = null;
    currentRoom = normalizedRoomCode;
    currentDisplayName = normalizedDisplayName;
    setRoomControlsBusy(false);

    if (roomChanged) {
        resetTrackingView();
    }

    if (roomCodeInput) {
        roomCodeInput.value = currentRoom;
    }

    if (displayNameInput) {
        displayNameInput.value = currentDisplayName;
        localStorage.setItem("device-tracking-name", currentDisplayName);
    }

    if (copyRoomLinkButton) {
        copyRoomLinkButton.hidden = false;
    }

    setRoomUrl(currentRoom);
    publishLocation();
    updateUserList();
    setStatus(`${currentDisplayName} joined room ${currentRoom}.`);
}

function failRoomJoin(message) {
    clearJoinTimeout();
    pendingRoom = null;
    setRoomControlsBusy(false);
    setStatus(message || "Could not join room.");
}

function joinRoom(roomCode) {
    const normalizedRoomCode = normalizeRoomCode(roomCode);
    const normalizedDisplayName = normalizeDisplayName(displayNameInput && displayNameInput.value);

    if (!isValidDisplayName(normalizedDisplayName)) {
        failRoomJoin("Enter your name with 2-30 characters.");
        return;
    }

    /* Room code validation is handled by the server –
       if the client sends an empty/invalid code, the server generates one */
    if (!socket.connected) {
        failRoomJoin("Still connecting to the server. Try again in a moment.");
        return;
    }

    pendingRoom = normalizedRoomCode;
    setRoomControlsBusy(true);
    setStatus(normalizedRoomCode ? `Joining room ${normalizedRoomCode}...` : "Creating a new room...");

    clearJoinTimeout();
    joinTimeout = setTimeout(() => {
        if (pendingRoom === normalizedRoomCode) {
            failRoomJoin("Room join timed out. Check the server and try again.");
        }
    }, 7000);

    socket.emit(
        "join-room",
        { roomCode: normalizedRoomCode, displayName: normalizedDisplayName },
        (response = {}) => {
            if (!response.ok) {
                failRoomJoin(response.error || "Could not join room.");
                return;
            }

            finishRoomJoin(response.roomCode, response.displayName);
        }
    );
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
    const targetLocation = selectedTargetId ? userLocations[selectedTargetId] : landmarks[selectedLandmarkId];

    if (!currentLocation) {
        setStatus("Waiting for your location before routing.");
        return;
    }

    if (!targetLocation) {
        clearRoute();
        setStatus("Selected destination is no longer available.");
        return;
    }

    const start = `${currentLocation.longitude},${currentLocation.latitude}`;
    const end = `${targetLocation.longitude},${targetLocation.latitude}`;
    const routeServers = {
        driving: "https://router.project-osrm.org/route/v1/driving",
        walking: "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
        cycling: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
    };
    const routeUrl = `${routeServers[selectedRouteMode] || routeServers.driving}/${start};${end}?overview=full&geometries=geojson`;

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
    if (!selectedTargetId && !selectedLandmarkId) {
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

function routeToUser(id, mode = "driving") {
    selectedRouteMode = mode;
    selectedLandmarkId = null;
    if (id === socket.id) {
        setStatus("That pin is your current location.");
        return;
    }

    selectedTargetId = id;
    drawRouteToSelectedUser();
}

function routeToLandmark(id, mode = selectedRouteMode) {
    if (!landmarks[id]) {
        setStatus("That landmark is no longer available.");
        return;
    }

    selectedTargetId = null;
    selectedLandmarkId = id;
    selectedRouteMode = mode;
    drawRouteToSelectedUser();
}
function bindMarkerPopup(id, marker) {
    const popupContent = document.createElement("div");
    popupContent.className = "marker-popup";

    const label = document.createElement("div");
    label.className = "marker-title";
    label.textContent = id === socket.id ? `You (${getMarkerName(id)})` : getMarkerName(id);
    popupContent.appendChild(label);

    if (id !== socket.id) {
        const modeSelect = document.createElement("select");
        modeSelect.className = "route-mode-select";
        modeSelect.setAttribute("aria-label", "Travel mode");
        [
            ["driving", "Driving"],
            ["walking", "Walking"],
            ["cycling", "Cycling"],
        ].forEach(([value, labelText]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = labelText;
            option.selected = value === selectedRouteMode;
            modeSelect.appendChild(option);
        });
        modeSelect.addEventListener("change", () => {
            selectedRouteMode = modeSelect.value;
        });
        popupContent.appendChild(modeSelect);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "route-button";
        button.textContent = selectedTargetId === id ? "Hide route" : "Show route";
        button.addEventListener("click", () => {
            if (selectedTargetId === id) {
                clearRoute();
                button.textContent = "Show route";
                setStatus("Route cleared.");
                return;
            }
            routeToUser(id, modeSelect.value);
            button.textContent = "Hide route";
        });
        popupContent.appendChild(button);
    }

    marker.bindPopup(popupContent);
}

if (displayNameInput) {
    displayNameInput.value = localStorage.getItem("device-tracking-name") || "";
    displayNameInput.addEventListener("input", () => {
        const normalizedDisplayName = normalizeDisplayName(displayNameInput.value);

        if (displayNameInput.value.length > 30) {
            displayNameInput.value = normalizedDisplayName;
        }

        updateJoinButtonState();
    });
}

if (roomCodeInput) {
    roomCodeInput.addEventListener("input", () => {
        const normalizedRoomCode = normalizeRoomCode(roomCodeInput.value);

        if (roomCodeInput.value !== normalizedRoomCode) {
            roomCodeInput.value = normalizedRoomCode;
        }

        updateJoinButtonState();
    });
}

let createButtonSuppressed = false;
let chatInput = null;
let chatForm = null;
let chatMessages = null;

if (roomForm) {
    roomForm.addEventListener("submit", (event) => {
        event.preventDefault();
        createButtonSuppressed = true;
        joinRoom(roomCodeInput.value);
        setTimeout(() => { createButtonSuppressed = false; }, 100);
    });

    /* Catch Enter key directly – prevents browsers from firing
       the createRoomButton click when the Join button is disabled */
    roomForm.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            createButtonSuppressed = true;
            joinRoom(roomCodeInput.value);
            setTimeout(() => { createButtonSuppressed = false; }, 100);
        }
    });
}

if (createRoomButton) {
    createRoomButton.addEventListener("click", () => {
        /* Prevent the Create button from firing when the user pressed Enter
           in the form – some browsers trigger type="button" on Enter */
        if (createButtonSuppressed) return;

        const inputValue = roomCodeInput?.value ?? '';
        const normalized = normalizeRoomCode(inputValue);
        let roomCode;
        if (isValidRoomCode(normalized)) {
            roomCode = normalized;
        } else {
            roomCode = generateRoomCode();
        }
        roomCodeInput.value = roomCode;
        updateJoinButtonState();
        joinRoom(roomCode);
    });
}

if (copyRoomLinkButton) {
    copyRoomLinkButton.addEventListener("click", copyInviteLink);
}

// Initialize chat elements
chatInput = document.getElementById("chat-input");
chatForm = document.getElementById("chat-form");
chatMessages = document.getElementById("chat-messages");

if (chatForm && chatInput) {
    chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const message = chatInput.value.trim();
        if (message && currentRoom) {
            socket.emit("chat-message", { message });
            chatInput.value = "";
        }
    });
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

            if (currentRoom) {
                publishLocation();

                if (selectedTargetId) {
                    scheduleRouteUpdate();
                } else {
                    setStatus(`Sharing location in room ${currentRoom}.`);
                }
            } else if (!pendingRoom) {
                setStatus("Enter your name, then create or join a room.");
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

socket.on("room-joined", (data = {}) => {
    finishRoomJoin(data.roomCode, data.displayName);
});

socket.on("room-error", (data = {}) => {
    failRoomJoin(data.error || "Could not join room.");
});

socket.on("receive-landmark", (landmark) => {
    addLandmarkMarker(landmark);
});

socket.on("landmark-removed", (id) => {
    if (landmarkMarkers[id]) {
        landmarkLayer.removeLayer(landmarkMarkers[id]);
        delete landmarkMarkers[id];
    }

    delete landmarks[id];
    if (selectedLandmarkId === id) {
        clearRoute();
        setStatus("Selected landmark was removed.");
    }
});
socket.on("receive-location", (data) => {
    const { id, latitude, longitude } = data;
    const name = normalizeDisplayName(data.name) || "Room member";

    if (!isValidCoordinate(latitude, longitude)) {
        return;
    }

    userLocations[id] = { latitude, longitude, name };

    if (!hasCenteredMap && id === socket.id) {
        map.setView([latitude, longitude], 16);
        hasCenteredMap = true;
    }

    if (markers[id]) {
        markers[id].setLatLng([latitude, longitude]);
        markerClusterGroup.refreshClusters(markers[id]);
        updateMarkerIdentity(id, markers[id]);
    } else {
        markers[id] = L.marker([latitude, longitude]);
        markerClusterGroup.addLayer(markers[id]);
        updateMarkerIdentity(id, markers[id]);
    }

    updateUserList();

    if (id === selectedTargetId || id === socket.id) {
        scheduleRouteUpdate();
    }
});

socket.on("user-disconnected", (id) => {
    delete userLocations[id];

    if (markers[id]) {
        markerClusterGroup.removeLayer(markers[id]);
        delete markers[id];
    }

    updateUserList();

    if (id === selectedTargetId) {
        clearRoute();
        setStatus("Selected user disconnected.");
    }
});

socket.on("chat-message", (data) => {
    const messageElement = document.createElement("div");
    messageElement.classList.add("chat-message");

    // Determine if this message is from the current user
    const isOwnMessage = data.id === socket.id;

    if (isOwnMessage) {
        messageElement.classList.add("own");
    } else {
        messageElement.classList.add("other");
    }

    // Add sender name for other users' messages
    if (!isOwnMessage) {
        const senderName = document.createElement("div");
        senderName.classList.add("chat-sender-name");
        senderName.textContent = data.name;
        messageElement.appendChild(senderName);
    }

    // Create message bubble
    const messageBubble = document.createElement("div");
    messageBubble.classList.add("chat-message-bubble");
    messageBubble.textContent = data.message;

    messageElement.appendChild(messageBubble);

    chatMessages.appendChild(messageElement);
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

socket.on("connect", () => {
    setRoomControlsBusy(false);

    if (currentRoom) {
        joinRoom(currentRoom);
    } else {
        setStatus("Connected. Enter your name, then create or join a room.");
    }
});

socket.on("disconnect", () => {
    clearJoinTimeout();
    pendingRoom = null;
    setRoomControlsBusy(false);
    setStatus("Disconnected from tracking server");
});

const roomFromUrl = normalizeRoomCode(new URLSearchParams(window.location.search).get("room"));

if (roomFromUrl) {
    roomCodeInput.value = roomFromUrl;
    updateJoinButtonState();

    if (isValidDisplayName(normalizeDisplayName(displayNameInput.value))) {
        if (socket.connected) {
            joinRoom(roomFromUrl);
        } else {
            socket.once("connect", () => joinRoom(roomFromUrl));
        }
    } else {
        setStatus(`Enter your name to join room ${roomFromUrl}.`);
    }
} else {
    updateJoinButtonState();
}