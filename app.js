const express = require("express");
const path = require("path");
const http = require("http");
const socketio = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;
const roomLocations = new Map();

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
        }
    }

    socket.to(roomCode).emit("user-disconnected", socket.id);
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
        const roomCode = normalizeRoomCode(data.roomCode);
        const displayName = normalizeDisplayName(data.displayName);

        if (!isValidRoomCode(roomCode)) {
            const response = { ok: false, error: "Room code must be 3-32 letters or numbers." };

            socket.emit("room-error", response);

            if (typeof callback === "function") {
                callback(response);
            }

            return;
        }

        if (!isValidDisplayName(displayName)) {
            const response = { ok: false, error: "Name must be 2-30 characters." };

            socket.emit("room-error", response);

            if (typeof callback === "function") {
                callback(response);
            }

            return;
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

    socket.on("disconnect", function () {
        removeSocketFromRoom(socket, currentRoom);
    });
});

app.get("/", function (req, res) {
    res.render("index");
});

server.listen(PORT, function () {
    console.log(`Server is running at http://localhost:${PORT}`);
});