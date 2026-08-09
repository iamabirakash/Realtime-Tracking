const express = require("express");
const path = require("path");
const http = require("http");
const socketio = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;
const roomLocations = new Map();
const roomLandmarks = new Map();

function normalizeRoomCode(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function normalizeDisplayName(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim().replace(/\s+/g, " ").slice(0, 30);
}

function isValidRoomCode(roomCode) {
    return /^[A-Z0-9_-]{3,32}$/.test(roomCode);
}

function isValidDisplayName(displayName) {
    return displayName.length >= 2 && displayName.length <= 30;
}

function generateRoomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ123456789";
    const bytes = new Array(8);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * alphabet.length);
    }
    return bytes.map((i) => alphabet[i]).join("");
}

function getRoomLandmarks(roomCode) {
    if (!roomLandmarks.has(roomCode)) {
        roomLandmarks.set(roomCode, new Map());
    }

    return roomLandmarks.get(roomCode);
}
function getRoomLocations(roomCode) {
    if (!roomLocations.has(roomCode)) {
        roomLocations.set(roomCode, new Map());
    }

    return roomLocations.get(roomCode);
}

function removeSocketFromRoom(socket, roomCode) {
    if (!roomCode) {
        return;
    }

    const locations = roomLocations.get(roomCode);

    if (locations) {
        locations.delete(socket.id);

        if (locations.size === 0) {
            roomLocations.delete(roomCode);
            roomLandmarks.delete(roomCode);
        }
    }

    socket.to(roomCode).emit("user-disconnected", socket.id);
}

function sendRoomLandmarks(socket, roomCode) {
    const landmarks = getRoomLandmarks(roomCode);

    landmarks.forEach(function (landmark) {
        socket.emit("receive-landmark", landmark);
    });
}
function sendRoomLocations(socket, roomCode) {
    const locations = getRoomLocations(roomCode);

    locations.forEach(function (location, id) {
        socket.emit("receive-location", { id, ...location });
    });
}

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", function (socket) {
    let currentRoom = null;
    let currentName = null;

    socket.on("join-room", function (data = {}, callback) {
        const displayName = normalizeDisplayName(data.displayName);

        if (!isValidDisplayName(displayName)) {
            const response = { ok: false, error: "Name must be 2-30 characters." };

            socket.emit("room-error", response);

            if (typeof callback === "function") {
                callback(response);
            }

            return;
        }

        let roomCode = normalizeRoomCode(data.roomCode);

        /* If the client didn't supply a valid room code, generate one on the server */
        if (!isValidRoomCode(roomCode)) {
            roomCode = generateRoomCode();
        }

        if (currentRoom && currentRoom !== roomCode) {
            socket.leave(currentRoom);
            removeSocketFromRoom(socket, currentRoom);
        }

        currentRoom = roomCode;
        currentName = displayName;
        socket.join(roomCode);

        const response = { ok: true, roomCode, displayName };
        socket.emit("room-joined", response);
        sendRoomLocations(socket, roomCode);
        sendRoomLandmarks(socket, roomCode);

        if (typeof callback === "function") {
            callback(response);
        }
    });

    socket.on("send-location", function (data = {}) {
        if (!currentRoom || !currentName) {
            return;
        }

        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return;
        }

        const location = { latitude, longitude, name: currentName };

        getRoomLocations(currentRoom).set(socket.id, location);
        io.to(currentRoom).emit("receive-location", { id: socket.id, ...location });
    });

    socket.on("add-landmark", function (data = {}, callback) {
        if (!currentRoom || !currentName) {
            if (typeof callback === "function") callback({ ok: false, error: "Join a room first." });
            return;
        }

        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        const label = typeof data.label === "string" ? data.label.trim().replace(/\s+/g, " ").slice(0, 50) : "";

        if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            if (typeof callback === "function") callback({ ok: false, error: "Enter a valid landmark name and location." });
            return;
        }

        const landmark = {
            id: `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            latitude,
            longitude,
            label,
            creatorId: socket.id,
            creatorName: currentName,
        };

        getRoomLandmarks(currentRoom).set(landmark.id, landmark);
        io.to(currentRoom).emit("receive-landmark", landmark);
        if (typeof callback === "function") callback({ ok: true, landmark });
    });

    socket.on("remove-landmark", function (data = {}) {
        if (!currentRoom || typeof data.id !== "string") {
            return;
        }

        const landmarks = getRoomLandmarks(currentRoom);
        const landmark = landmarks.get(data.id);

        if (!landmark || landmark.creatorId !== socket.id) {
            return;
        }

        landmarks.delete(data.id);
        io.to(currentRoom).emit("landmark-removed", data.id);
    });
    socket.on("chat-message", function (data = {}) {
        if (!currentRoom || !currentName) {
            return;
        }

        const message = typeof data.message === "string" ? data.message.trim().slice(0, 240) : "";
        if (!message) {
            return;
        }

        // Broadcast the message to everyone in the room, including the sender
        io.to(currentRoom).emit("chat-message", {
            id: socket.id,
            message: message,
            name: currentName
        });
    });

    socket.on("disconnect", function () {
        removeSocketFromRoom(socket, currentRoom);
    });
});

app.get("/", function (req, res) {
    res.render("index");
});

app.get("/app", function (req, res) {
    res.render("app");
});

server.listen(PORT, function () {
    console.log(`Server is running at http://localhost:${PORT}`);
});