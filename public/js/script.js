"use strict";

(() => {
    const byId = (id) => document.getElementById(id);
    const onboarding = byId("room-panel");
    const feedback = byId("join-feedback");
    const statusText = document.querySelector("#status .status-text");
    let statusTimer;
    function setStatus(message) {
        statusText.textContent = message;
        if (!onboarding.hidden) feedback.textContent = message;
        byId("status").classList.add("show");
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => byId("status").classList.remove("show"), 6500);
    }
    if (!window.L || !window.io || typeof createRouteController !== "function") {
        setStatus("The app could not load. Check your connection and reload this page.");
        return;
    }
    function storage(area, key, value) {
        try {
            if (value === undefined) return window[area].getItem(key);
            if (value === null) window[area].removeItem(key);
            else window[area].setItem(key, value);
        } catch { /* Persistence is optional; the active page still works. */ }
        return null;
    }
    const socket = io({ autoConnect: false, auth: { token: storage("sessionStorage", "pingroom-session") } });
    const nameInput = byId("display-name");
    const codeInput = byId("room-code");
    const sheet = byId("sheet");
    const sheetHandle = byId("sheet-handle");
    const sheetChevron = byId("sheet-chevron");
    const chatInput = byId("chat-input");
    const chatMessages = byId("chat-messages");
    const members = new Map();
    const userLocations = new Map();
    const markers = new Map();
    const landmarks = new Map();
    const landmarkMarkers = new Map();
    const messages = new Map();
    let myMemberId = null;
    let currentRoom = null;
    let currentDisplayName = "";
    let joined = false;
    let joining = false;
    let sessionReady = false;
    let hostId = null;
    let roomExpiresAt = null;
    let joinGeneration = 0;
    let watchId = null;
    let sharingRequested = false;
    let currentLocation = null;
    let publishTimer = null;
    let lastPublishedAt = 0;
    let landmarkMode = false;
    let selectedDestination = null;
    let routeLayer = null;
    let routeUpdateTimer = null;
    let centered = false;
    let chatSending = false;
    let pendingMessage = null;
    let renderFrame = null;
    let config = { staleLocationMs: 60000, routes: {} };
    const configReady = fetch("/api/config").then((response) => {
        if (!response.ok) throw new Error("Configuration unavailable");
        return response.json();
    }).then((value) => { config = value; }).catch(() => setStatus("Directions are unavailable. You can still use rooms and chat."));
    const validCode = (value) => /^[A-F0-9]{16}$/.test(value.trim().toUpperCase());
    const validName = (value) => value.trim().length >= 2 && value.length <= 30;
    const validCoordinates = (value) => value && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
        && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
    const initials = (name) => name.trim().split(/\s+/u).map((part) => Array.from(part)[0]).slice(0, 2).join("").toUpperCase();
    const palette = ["#14B8A6", "#818CF8", "#FBBF24", "#38BDF8", "#F472B6", "#A78BFA"];
    const colorFor = (id) => palette[Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % palette.length];
    function element(tag, className, content) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (content !== undefined) node.textContent = content;
        return node;
    }
    function request(event, data, timeout = 6000) {
        return new Promise((resolve, reject) => {
            if (!socket.connected || !sessionReady) return reject(new Error("Not connected. Wait for reconnection and try again."));
            socket.timeout(timeout).emit(event, data, (error, response) => {
                if (error) reject(new Error("No delivery confirmation. Please try again."));
                else if (!response?.ok) reject(new Error(response?.error || "The request failed."));
                else resolve(response);
            });
        });
    }
    function updateControls() {
        const connected = socket.connected && sessionReady;
        byId("create-room").disabled = !connected || joining || !validName(nameInput.value);
        byId("join-room").disabled = !connected || joining || !validName(nameInput.value) || !validCode(codeInput.value);
        nameInput.disabled = joining;
        codeInput.disabled = joining;
        byId("copy-room-link").disabled = !joined;
        byId("menu-close").hidden = hostId !== myMemberId || !joined;
        byId("share-location").disabled = !joined;
        byId("share-location").textContent = sharingRequested ? "Pause sharing" : "Share location";
        byId("share-location").setAttribute("aria-pressed", String(sharingRequested));
        byId("chat-send").disabled = !joined || !connected || chatSending;
        chatInput.disabled = !joined;
        byId("landmark-btn").disabled = !joined || !connected;
        byId("landmark-btn").setAttribute("aria-pressed", String(landmarkMode));
        byId("room-pill").classList.toggle("offline", !joined || !connected);
        const connection = !socket.connected ? "Offline · reconnecting" : !sessionReady || joining ? "Connecting…" : joined ? "Connected" : "Ready to join";
        byId("connection-status").textContent = connection;
        byId("sharing-status").textContent = !joined ? "Location sharing is off" : sharingRequested
            ? currentLocation ? "Your location is sharing" : "Waiting for a location fix" : "Your location is paused";
    }

    const map = L.map("map", { zoomControl: false }).setView([0, 0], 2);
    const baseLayers = {
        Standard: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OpenStreetMap</a> contributors' }),
        Satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" }),
        Terrain: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)" }),
        Dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, subdomains: "abcd", attribution: "&copy; OpenStreetMap contributors &copy; CARTO" }),
    };
    baseLayers.Standard.addTo(map);
    let tileErrorAt = 0;
    Object.values(baseLayers).forEach((layer) => layer.on("tileerror", () => {
        if (Date.now() - tileErrorAt > 30000) {
            tileErrorAt = Date.now();
            setStatus("Some map tiles could not load. Try a different map layer or check your connection.");
        }
    }));
    L.control.layers(baseLayers, null, { position: "bottomleft" }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    const markerGroup = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 }).addTo(map);
    const landmarkLayer = L.layerGroup().addTo(map);

    function mapPadding() {
        return { paddingTopLeft: [30, 80], paddingBottomRight: [35, window.innerWidth < 900 ? Math.min(sheet.getBoundingClientRect().height + 35, window.innerHeight * 0.65) : 35], maxZoom: 17 };
    }
    function clearRoute() {
        selectedDestination = null;
        clearTimeout(routeUpdateTimer);
        routeUpdateTimer = null;
        router.clear();
        syncRouteButtons();
    }
    const router = createRouteController({
        onClear() { if (routeLayer) map.removeLayer(routeLayer); routeLayer = null; },
        onStatus: setStatus,
        onRoute(points, info) {
            routeLayer = L.polyline(points, { color: "#2563eb", weight: 5, opacity: 0.9, dashArray: info.direct ? "8 10" : null }).addTo(map);
            map.fitBounds(routeLayer.getBounds(), mapPadding());
            if (!info.direct) setStatus(`Route: ${Number.isFinite(info.distance) ? (info.distance / 1000).toFixed(2) + " km" : "distance unavailable"} · ${Number.isFinite(info.duration) ? Math.max(1, Math.round(info.duration / 60)) + " min" : "time unavailable"}`);
        },
    });
    function syncRouteButtons() {
        document.querySelectorAll("[data-route-key]").forEach((button) => {
            button.textContent = selectedDestination?.key === button.dataset.routeKey ? "Hide route" : "Show route";
        });
    }
    async function drawSelectedRoute() {
        if (!joined || !selectedDestination || !currentLocation) return;
        const selection = selectedDestination;
        await configReady;
        if (selectedDestination !== selection || !joined) return;
        const target = selection.kind === "member" ? userLocations.get(selection.id) : landmarks.get(selection.id);
        if (!target || !validCoordinates(currentLocation)) { clearRoute(); return; }
        const endpoint = config.routes[selection.mode];
        if (!endpoint) { clearRoute(); setStatus("Directions are unavailable. Try again later."); return; }
        void router.calculate({ ...currentLocation }, { ...target }, endpoint);
    }
    function scheduleRouteUpdate() {
        if (!selectedDestination || routeUpdateTimer) return;
        routeUpdateTimer = setTimeout(() => { routeUpdateTimer = null; void drawSelectedRoute(); }, 1500);
    }
    function routeControls(kind, id) {
        const box = element("div", "route-controls");
        const select = element("select", "route-mode-select");
        select.setAttribute("aria-label", "Travel mode");
        [["driving", "Car"], ["walking", "Walk"], ["cycling", "Cycle"]].forEach(([value, label]) => {
            const option = element("option", "", label); option.value = value; select.append(option);
        });
        const key = `${kind}:${id}`;
        if (selectedDestination?.key === key) select.value = selectedDestination.mode;
        const button = element("button", "route-button", selectedDestination?.key === key ? "Hide route" : "Show route");
        button.type = "button";
        button.dataset.routeKey = key;
        button.addEventListener("click", () => {
            if (selectedDestination?.key === key) { clearRoute(); setStatus("Route cleared."); return; }
            if (!currentLocation || !sharingRequested) { setStatus("Share your location to use it as the route start."); return; }
            clearRoute();
            selectedDestination = { key, kind, id, mode: select.value };
            syncRouteButtons();
            void drawSelectedRoute();
        });
        select.addEventListener("change", () => {
            if (selectedDestination?.key === key) { selectedDestination.mode = select.value; void drawSelectedRoute(); }
        });
        box.append(select, button);
        return box;
    }
    function memberPopup(id) {
        const member = members.get(id);
        const box = element("div", "marker-popup");
        box.append(element("strong", "marker-title", `${member?.name || "Member"}${id === myMemberId ? " (you)" : ""}`));
        const position = userLocations.get(id);
        if (position) box.append(element("span", "landmark-creator", `Reported accuracy ±${Math.round(position.accuracy)} m`));
        if (id !== myMemberId) box.append(routeControls("member", id));
        return box;
    }
    function synchronizeMarker(member) {
        const position = member.location;
        const usable = member.connected && validCoordinates(position) && Date.now() - position.receivedAt <= config.staleLocationMs;
        if (!usable) {
            userLocations.delete(member.id);
            if (markers.has(member.id)) { markerGroup.removeLayer(markers.get(member.id)); markers.delete(member.id); }
            if (selectedDestination?.kind === "member" && selectedDestination.id === member.id) clearRoute();
            return;
        }
        const previous = userLocations.get(member.id);
        const moved = !previous || previous.latitude !== position.latitude || previous.longitude !== position.longitude;
        userLocations.set(member.id, { ...position, name: member.name });
        let marker = markers.get(member.id);
        const tooltip = element("span", "", `${member.name}${member.id === myMemberId ? " (you)" : ""}`);
        if (marker) { marker.setLatLng([position.latitude, position.longitude]); marker.setTooltipContent(tooltip); }
        else {
            marker = L.marker([position.latitude, position.longitude], { title: member.name, alt: `Location of ${member.name}` });
            marker.bindTooltip(tooltip, { direction: "top" });
            marker.bindPopup(memberPopup(member.id));
            marker.on("popupopen", () => marker.setPopupContent(memberPopup(member.id)));
            markers.set(member.id, marker);
            markerGroup.addLayer(marker);
        }
        if (!centered && member.id === myMemberId) { map.setView([position.latitude, position.longitude], 16); centered = true; }
        if (moved && selectedDestination && (selectedDestination.id === member.id || member.id === myMemberId)) scheduleRouteUpdate();
    }
    function addLandmarkMarker(pin) {
        if (!pin || !validCoordinates(pin) || typeof pin.id !== "string") return;
        landmarks.set(pin.id, pin);
        if (landmarkMarkers.has(pin.id)) landmarkLayer.removeLayer(landmarkMarkers.get(pin.id));
        const box = element("div", "landmark-popup");
        box.append(element("strong", "", pin.label), element("div", "landmark-creator", `Added by ${pin.creatorName}`), routeControls("landmark", pin.id));
        const remove = element("button", "landmark-remove-button", pin.creatorId === myMemberId ? "Remove pin" : "Only creator can remove");
        remove.type = "button";
        remove.disabled = pin.creatorId !== myMemberId;
        remove.addEventListener("click", async () => {
            remove.disabled = true;
            try { await request("remove-landmark", { id: pin.id }); }
            catch (error) { remove.disabled = false; setStatus(error.message); }
        });
        box.append(remove);
        const marker = L.marker([pin.latitude, pin.longitude], { title: `Pin: ${pin.label}`, alt: `Shared pin: ${pin.label}` }).bindPopup(box);
        landmarkMarkers.set(pin.id, marker);
        landmarkLayer.addLayer(marker);
    }
    function removeLandmark(id) {
        if (landmarkMarkers.has(id)) landmarkLayer.removeLayer(landmarkMarkers.get(id));
        landmarkMarkers.delete(id); landmarks.delete(id);
        if (selectedDestination?.kind === "landmark" && selectedDestination.id === id) clearRoute();
    }
    function clearTrackingView() {
        clearRoute(); markerGroup.clearLayers(); landmarkLayer.clearLayers();
        members.clear(); userLocations.clear(); markers.clear(); landmarks.clear(); landmarkMarkers.clear(); messages.clear();
        chatMessages.replaceChildren(); centered = false;
    }
    function centerMember(id) {
        const position = userLocations.get(id);
        if (!position) { setStatus("This member is not sharing a current location."); return; }
        const marker = markers.get(id);
        map.setView([position.latitude, position.longitude], 17);
        if (marker) markerGroup.zoomToShowLayer(marker, () => marker.openPopup());
        if (window.innerWidth < 900) setSheetExpanded(false);
    }
    function presence(member) {
        if (!member.connected) return "Disconnected · waiting to reconnect";
        if (!member.sharing) return "Location paused";
        if (!member.location) return "Location unavailable or stale";
        const age = Math.max(0, Math.floor((Date.now() - member.location.receivedAt) / 1000));
        return `Updated ${age < 5 ? "just now" : `${age}s ago`} · ±${Math.round(member.location.accuracy)} m`;
    }
    function renderMembers() {
        renderFrame = null;
        const focusedId = document.activeElement?.dataset.memberId;
        const list = byId("user-list");
        const avatars = byId("avatar-row");
        list.replaceChildren(); avatars.replaceChildren();
        for (const member of members.values()) {
            const row = element("li", "user-item" + (member.id === myMemberId ? " user-item--me" : ""));
            const button = element("button", "member-button"); button.type = "button"; button.dataset.memberId = member.id;
            const dot = element("span", "user-dot" + (member.id === myMemberId ? " user-dot--me" : ""));
            dot.classList.toggle("paused", !member.connected || !member.location);
            dot.setAttribute("aria-hidden", "true");
            const copy = element("span", "member-copy");
            copy.append(element("span", "member-name", `${member.name}${member.id === myMemberId ? " (you)" : ""}`), element("span", "member-presence", presence(member)));
            button.append(dot, copy); button.addEventListener("click", () => centerMember(member.id)); row.append(button); list.append(row);
            const avatar = element("button", "avatar-chip" + (member.id === myMemberId ? " me" : ""), initials(member.name));
            avatar.type = "button"; avatar.style.setProperty("--c", colorFor(member.id));
            avatar.setAttribute("aria-label", `${member.name}: ${presence(member)}`); avatar.title = member.name;
            avatar.addEventListener("click", () => centerMember(member.id)); avatars.append(avatar);
        }
        if (!members.size) list.append(element("li", "empty-state", "Join a room to see its members."));
        byId("member-count").textContent = String(members.size);
        if (focusedId) [...list.querySelectorAll("button")].find((button) => button.dataset.memberId === focusedId)?.focus({ preventScroll: true });
        updateControls(); scheduleLayout();
    }
    function scheduleMembers() { if (!renderFrame) renderFrame = requestAnimationFrame(renderMembers); }
    function appendMessage(item) {
        if (!item || messages.has(item.messageId)) return;
        messages.set(item.messageId, item);
        const row = element("div", `chat-message ${item.id === myMemberId ? "own" : "other"}`);
        row.style.setProperty("--sender-color", colorFor(item.id));
        if (item.id !== myMemberId) row.append(element("div", "chat-sender-name", item.name));
        row.append(element("div", "chat-message-bubble", item.message));
        chatMessages.append(row);
        while (messages.size > 100) { messages.delete(messages.keys().next().value); chatMessages.firstElementChild?.remove(); }
        byId("chat-empty").hidden = messages.size > 0;
        const panel = byId("panel-chat");
        requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });
    }
    function applySnapshot(state) {
        if (!joined || state.roomCode !== currentRoom) return;
        hostId = state.hostId; roomExpiresAt = state.expiresAt;
        const nextIds = new Set(state.members.map((member) => member.id));
        for (const id of members.keys()) if (!nextIds.has(id)) {
            members.delete(id); userLocations.delete(id);
            if (markers.has(id)) markerGroup.removeLayer(markers.get(id)); markers.delete(id);
            if (selectedDestination?.kind === "member" && selectedDestination.id === id) clearRoute();
        }
        for (const member of state.members) { members.set(member.id, member); synchronizeMarker(member); }
        const pinIds = new Set(state.landmarks.map((pin) => pin.id));
        for (const id of landmarks.keys()) if (!pinIds.has(id)) removeLandmark(id);
        for (const pin of state.landmarks) if (!landmarks.has(pin.id)) addLandmarkMarker(pin);
        for (const item of state.messages) appendMessage(item);
        scheduleMembers();
    }
    function setMenu(open, focus = false) {
        byId("you-menu").hidden = !open;
        byId("you-menu").classList.toggle("open", open);
        byId("you-chip").setAttribute("aria-expanded", String(open));
        if (open && focus) byId("copy-room-link").focus();
    }
    byId("you-chip").addEventListener("click", () => setMenu(byId("you-menu").hidden, true));
    document.addEventListener("click", (event) => { if (!event.target.closest(".profile-menu")) setMenu(false); });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            if (!byId("you-menu").hidden) { setMenu(false); byId("you-chip").focus(); }
            if (landmarkMode) toggleLandmarkMode(false);
        }
        if (event.key === "Tab" && !onboarding.hidden) {
            const focusables = [...onboarding.querySelectorAll("input:not(:disabled),button:not(:disabled),a[href]")].filter((node) => node.getClientRects().length);
            const first = focusables[0], last = focusables.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    byId("you-menu").addEventListener("keydown", (event) => {
        if (event.key === "Tab") { setMenu(false); byId("you-chip").focus(); return; }
        const items = [...byId("you-menu").querySelectorAll("button:not([hidden]):not(:disabled)")];
        const index = items.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        }
    });

    async function joinRoom(action = "join") {
        if (joining) return;
        const displayName = action === "resume" ? currentDisplayName : nameInput.value.trim().replace(/\s+/gu, " ");
        const roomCode = action === "resume" ? currentRoom : codeInput.value.trim().toUpperCase();
        if (!validName(displayName) || (action !== "create" && !validCode(roomCode))) {
            setStatus("Enter your name and a complete 16-character room code."); return;
        }
        const version = ++joinGeneration;
        joining = true; updateControls();
        try {
            const response = await request("join-room", { action, roomCode, displayName });
            if (version !== joinGeneration || !socket.connected) return;
            currentRoom = response.snapshot.roomCode; currentDisplayName = displayName;
            myMemberId = response.memberId; joined = true;
            clearTrackingView(); applySnapshot(response.snapshot);
            storage("localStorage", "device-tracking-name", displayName);
            byId("room-name").textContent = currentRoom;
            byId("you-chip").textContent = initials(displayName);
            codeInput.value = currentRoom;
            const url = new URL(location.href); url.searchParams.set("room", currentRoom); history.replaceState(null, "", url);
            onboarding.hidden = true; onboarding.inert = true; byId("app-shell").inert = false;
            setMenu(false); byId("you-chip").focus({ preventScroll: true });
            if (action !== "resume") sharingRequested = byId("share-on-join").checked;
            if (sharingRequested) startWatching();
            setStatus(action === "resume" ? "Reconnected. Room state is up to date." : `Joined room ${currentRoom}.`);
            scheduleLayout();
        } catch (error) {
            if (version !== joinGeneration) return;
            if (action === "resume") leaveView();
            setStatus(error.message);
        } finally { if (version === joinGeneration) { joining = false; updateControls(); } }
    }
    function stopWatching() {
        if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
        watchId = null; clearTimeout(publishTimer); publishTimer = null;
        currentLocation = null; lastPublishedAt = 0;
    }
    function publishLocation() {
        publishTimer = null;
        if (!joined || !socket.connected || !sessionReady || !sharingRequested || !currentLocation
            || Date.now() - currentLocation.timestamp > config.staleLocationMs) return;
        const delay = 3000 - (Date.now() - lastPublishedAt);
        if (delay > 0) { publishTimer = setTimeout(publishLocation, delay); return; }
        lastPublishedAt = Date.now();
        socket.volatile.emit("send-location", { ...currentLocation });
    }
    function startWatching() {
        stopWatching();
        if (!joined || !socket.connected || !sharingRequested) return;
        if (!window.isSecureContext || !navigator.geolocation) {
            sharingRequested = false; updateControls();
            setStatus(!window.isSecureContext ? "Location needs HTTPS. Open this site over HTTPS; plain LAN HTTP cannot share location." : "Geolocation is unavailable in this browser.");
            return;
        }
        watchId = navigator.geolocation.watchPosition((position) => {
            if (!sharingRequested || !joined) return;
            const { latitude, longitude, accuracy } = position.coords;
            if (!validCoordinates({ latitude, longitude }) || !Number.isFinite(accuracy)) return;
            currentLocation = { latitude, longitude, accuracy, timestamp: position.timestamp };
            if (!publishTimer) publishLocation();
            updateControls();
        }, (error) => {
            currentLocation = null;
            if (error.code === 1) { sharingRequested = false; stopWatching(); }
            if (joined && socket.connected) void request("pause-location", {}).catch(() => {});
            clearRoute(); updateControls();
            setStatus(error.code === 1 ? "Location permission denied. Enable it in browser settings, then select Share location." : error.code === 3 ? "Location timed out. Check GPS or move somewhere with a clearer signal." : "Location is unavailable. Check your device location settings.");
        }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 5000 });
        updateControls();
    }
    byId("share-location").addEventListener("click", async () => {
        if (!joined) return;
        if (sharingRequested) {
            sharingRequested = false; stopWatching(); clearRoute(); updateControls();
            if (socket.connected) try { await request("pause-location", {}); setStatus("Location sharing paused."); } catch (error) { setStatus(error.message); }
        } else if (socket.connected) { sharingRequested = true; startWatching(); }
        else setStatus("Wait for reconnection before sharing.");
    });
    function leaveView() {
        ++joinGeneration; joining = false; joined = false; currentRoom = null; sharingRequested = false;
        stopWatching(); clearTrackingView(); hostId = null; roomExpiresAt = null;
        pendingMessage = null; chatSending = false; chatInput.value = "";
        byId("room-name").textContent = "No room";
        byId("you-chip").textContent = "?";
        onboarding.hidden = false; onboarding.inert = false; byId("app-shell").inert = true;
        setMenu(false); nameInput.disabled = false; codeInput.disabled = false;
        const url = new URL(location.href); url.searchParams.delete("room"); history.replaceState(null, "", url);
        renderMembers(); nameInput.focus();
    }
    byId("menu-leave").addEventListener("click", async () => {
        if (!socket.connected) { socket.disconnect(); leaveView(); socket.connect(); return; }
        try { await request("leave-room", {}); leaveView(); setStatus("You left the room."); }
        catch (error) { setStatus(error.message); }
    });
    byId("menu-close").addEventListener("click", async () => {
        if (!window.confirm("Close this room for everyone and delete its positions, pins, and chat?")) return;
        try { await request("close-room", {}); }
        catch (error) { setStatus(error.message); }
    });
    byId("copy-room-link").addEventListener("click", async () => {
        if (!joined) return;
        const url = new URL("/app", location.href); url.searchParams.set("room", currentRoom);
        try { await navigator.clipboard.writeText(url.href); setStatus("Meeting link copied."); }
        catch { window.prompt("Copy meeting link", url.href); }
        setMenu(false);
    });
    byId("room-form").addEventListener("submit", (event) => { event.preventDefault(); void joinRoom("join"); });
    byId("create-room").addEventListener("click", () => void joinRoom("create"));
    nameInput.addEventListener("input", updateControls);
    codeInput.addEventListener("input", updateControls);
    byId("chat-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = chatInput.value.trim();
        if (!message || chatSending || !joined) return;
        if (!pendingMessage || pendingMessage.message !== message || pendingMessage.roomCode !== currentRoom) {
            const messageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
            pendingMessage = { messageId, message, roomCode: currentRoom };
        }
        const attempt = pendingMessage;
        chatSending = true; byId("chat-feedback").textContent = "Sending…"; updateControls();
        try {
            const response = await request("chat-message", { messageId: attempt.messageId, message: attempt.message });
            if (currentRoom !== attempt.roomCode) return;
            appendMessage(response.message);
            if (chatInput.value.trim() === attempt.message) chatInput.value = "";
            pendingMessage = null; byId("chat-feedback").textContent = "Delivered";
        } catch (error) {
            if (currentRoom === attempt.roomCode) byId("chat-feedback").textContent = `${error.message} Your draft is kept; send again to retry.`;
        } finally { chatSending = false; updateControls(); }
    });

    function setSheetExpanded(expanded) {
        sheet.dataset.state = expanded ? "expanded" : "peek";
        sheetChevron.setAttribute("aria-expanded", String(expanded));
        sheetChevron.setAttribute("aria-label", expanded ? "Collapse panel" : "Expand panel");
        byId("sheet-body").inert = window.innerWidth < 900 && !expanded;
        scheduleLayout();
    }
    sheetChevron.addEventListener("click", () => setSheetExpanded(sheet.dataset.state !== "expanded"));
    const tabs = [...document.querySelectorAll(".tab")];
    function selectTab(tab, focus = false) {
        tabs.forEach((item) => {
            const active = item === tab;
            item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1;
            byId(item.getAttribute("aria-controls")).hidden = !active;
        });
        setSheetExpanded(true);
        if (focus) tab.focus();
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => selectTab(tab));
        tab.addEventListener("keydown", (event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            selectTab(tabs[next], true);
        });
    });
    let drag = null;
    sheetHandle.addEventListener("pointerdown", (event) => {
        if (window.innerWidth >= 900 || event.target.closest("button") || !event.isPrimary) return;
        drag = { y: event.clientY, expanded: sheet.dataset.state === "expanded", delta: 0 };
        sheetHandle.setPointerCapture(event.pointerId);
    });
    sheetHandle.addEventListener("pointermove", (event) => {
        if (!drag) return;
        drag.delta = event.clientY - drag.y;
        const matrix = drag.expanded ? 0 : Math.max(0, sheet.offsetHeight - Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-peek")));
        sheet.style.transition = "none";
        sheet.style.transform = `translateY(${Math.max(0, Math.min(sheet.offsetHeight - 44, matrix + drag.delta))}px)`;
    });
    function endDrag(event, cancel = false) {
        if (!drag) return;
        const expanded = cancel || Math.abs(drag.delta) < 35 ? drag.expanded : drag.delta < 0;
        drag = null; sheet.style.transition = ""; sheet.style.transform = "";
        if (sheetHandle.hasPointerCapture(event.pointerId)) sheetHandle.releasePointerCapture(event.pointerId);
        setSheetExpanded(expanded);
    }
    sheetHandle.addEventListener("pointerup", (event) => endDrag(event));
    sheetHandle.addEventListener("pointercancel", (event) => endDrag(event, true));
    sheetHandle.addEventListener("lostpointercapture", (event) => endDrag(event, true));
    let layoutFrame = null;
    function scheduleLayout() {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = null;
            const desktop = window.innerWidth >= 900;
            const header = sheet.querySelector(".sheet-peek");
            const handleHeight = desktop ? 0 : sheetHandle.offsetHeight;
            const peek = Math.min(sheet.offsetHeight, header.offsetHeight + handleHeight + 8);
            document.documentElement.style.setProperty("--sheet-peek", `${peek}px`);
            document.documentElement.style.setProperty("--sheet-visual", `${desktop ? 0 : sheet.dataset.state === "expanded" ? sheet.offsetHeight : peek}px`);
            byId("sheet-body").inert = !desktop && sheet.dataset.state !== "expanded";
            map.invalidateSize({ pan: false });
        });
    }
    new ResizeObserver(scheduleLayout).observe(sheet);
    new ResizeObserver(scheduleLayout).observe(sheet.querySelector(".sheet-peek"));
    window.addEventListener("resize", scheduleLayout);
    window.visualViewport?.addEventListener("resize", scheduleLayout);
    byId("locate-btn").addEventListener("click", () => {
        if (!currentLocation) { setStatus("Select Share location and wait for a location fix."); return; }
        map.invalidateSize(); map.stop(); map.setView([currentLocation.latitude, currentLocation.longitude], 17, { animate: false });
        if (window.innerWidth < 900) setSheetExpanded(false);
        const marker = markers.get(myMemberId);
        if (marker) markerGroup.zoomToShowLayer(marker, () => marker.openPopup());
    });
    byId("fit-all-btn").addEventListener("click", () => {
        const positions = [...userLocations.values()].map((position) => [position.latitude, position.longitude]);
        if (!positions.length) { setStatus("No current locations are being shared."); return; }
        map.fitBounds(L.latLngBounds(positions), mapPadding());
    });
    function toggleLandmarkMode(active) {
        landmarkMode = active; byId("landmark-btn").classList.toggle("active", active);
        byId("landmark-btn").setAttribute("aria-pressed", String(active));
        map.getContainer().style.cursor = active ? "crosshair" : "";
    }
    byId("landmark-btn").addEventListener("click", () => {
        toggleLandmarkMode(!landmarkMode);
        setStatus(landmarkMode ? "Tap the map to add a named pin. Press Escape to cancel." : "Pin placement cancelled.");
        if (landmarkMode && window.innerWidth < 900) setSheetExpanded(false);
    });
    map.on("click", async (event) => {
        if (!landmarkMode || !joined) return;
        const label = window.prompt("Pin name (1–50 characters)");
        if (!label?.trim()) { toggleLandmarkMode(false); return; }
        toggleLandmarkMode(false);
        try { await request("add-landmark", { latitude: event.latlng.lat, longitude: event.latlng.lng, label: label.trim() }); setStatus("Shared pin added."); }
        catch (error) { setStatus(error.message); }
    });

    socket.on("session", (data) => {
        myMemberId = data.memberId; socket.auth = { token: data.token };
        storage("sessionStorage", "pingroom-session", data.token); sessionReady = true; updateControls();
        if (currentRoom) void joinRoom("resume");
    });
    socket.on("connect", updateControls);
    socket.on("disconnect", () => {
        ++joinGeneration; joining = false; sessionReady = false; joined = false;
        stopWatching(); clearTrackingView(); toggleLandmarkMode(false); renderMembers();
        setStatus("Disconnected. Positions are hidden until the room resynchronizes.");
    });
    socket.on("connect_error", () => { sessionReady = false; updateControls(); setStatus("Cannot connect to the server. Check your connection; the app will retry."); });
    socket.on("session-replaced", () => { currentRoom = null; leaveView(); setStatus("This session opened in another connection. Join again to continue."); });
    socket.on("server-restarting", () => setStatus("The server is restarting. Rooms may need to be recreated."));
    socket.on("room-state", (state) => applySnapshot(state));
    socket.on("receive-location", (data) => {
        if (!joined || data.roomCode !== currentRoom) return;
        members.set(data.member.id, data.member); synchronizeMarker(data.member); scheduleMembers();
    });
    socket.on("receive-landmark", (data) => { if (joined && data.roomCode === currentRoom) addLandmarkMarker(data.landmark); });
    socket.on("landmark-removed", (data) => { if (joined && data.roomCode === currentRoom) removeLandmark(data.id); });
    socket.on("chat-message", (data) => { if (joined && data.roomCode === currentRoom) appendMessage(data.message); });
    socket.on("room-closed", (data) => { if (data.roomCode === currentRoom) { leaveView(); setStatus(data.reason); } });
    window.addEventListener("pagehide", () => { stopWatching(); socket.disconnect(); });
    window.addEventListener("pageshow", (event) => { if (event.persisted) socket.connect(); });
    setInterval(() => {
        if (!joined) return;
        for (const member of members.values()) synchronizeMarker(member);
        if (currentLocation && Date.now() - currentLocation.timestamp > config.staleLocationMs) { currentLocation = null; clearRoute(); }
        byId("room-expiry").textContent = `Expires in ${Math.max(0, Math.ceil((roomExpiresAt - Date.now()) / 60000))} min`;
        scheduleMembers();
    }, 10000);
    nameInput.value = storage("localStorage", "device-tracking-name") || "";
    const invitedRoom = new URLSearchParams(location.search).get("room");
    if (invitedRoom) {
        codeInput.value = invitedRoom;
        feedback.textContent = validCode(invitedRoom) ? "Check your name and choose Join. Location sharing is optional." : "This invite has an invalid room code. Ask for a new link.";
    }
    if (!window.isSecureContext) byId("secure-context-notice").hidden = false;
    setSheetExpanded(false); renderMembers(); updateControls(); socket.connect();
})();
