"use strict";

const express = require("express");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const helmet = require("helmet");
const { Server } = require("socket.io");

const DEFAULT_LIMITS = Object.freeze({
    rooms: 200, members: 50, pins: 100, messages: 100, sessions: 10000,
    connectionsPerIp: 40, connections: 1000, roomLifetimeMs: 2 * 60 * 60 * 1000,
    pinLifetimeMs: 60 * 60 * 1000, reconnectGraceMs: 30000,
    sessionLifetimeMs: 3 * 60 * 60 * 1000, staleLocationMs: 60000,
});
const DEFAULT_ROUTES = Object.freeze({
    driving: "https://router.project-osrm.org/route/v1/driving",
    walking: "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
    cycling: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
});
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, min, max) => {
    if (typeof value !== "string" || value.length > max) return null;
    const result = value.trim().replace(/\s+/gu, " ");
    return result.length >= min && !/[\u0000-\u001f\u007f]/u.test(result) ? result : null;
};
const normalizeCode = (value) => typeof value === "string" ? value.trim().toUpperCase() : "";
const validCode = (value) => /^[A-F0-9]{16}$/.test(value);
const validPosition = (data) => typeof data.latitude === "number" && Number.isFinite(data.latitude)
    && Math.abs(data.latitude) <= 90 && typeof data.longitude === "number"
    && Number.isFinite(data.longitude) && Math.abs(data.longitude) <= 180;

function createTrackingServer(options = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const now = options.now || Date.now;
    const rooms = new Map();
    const sessions = new Map();
    const ipBuckets = new Map();
    const activeIps = new Map();
    const routes = { ...DEFAULT_ROUTES, ...options.routes };
    for (const mode of Object.keys(routes)) {
        routes[mode] = process.env[`ROUTING_${mode.toUpperCase()}_URL`] || routes[mode];
        if (new URL(routes[mode]).protocol !== "https:") throw new Error("Routing URLs must use HTTPS.");
    }
    const configuredOrigins = options.allowedOrigins || (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
    const allowedOrigins = new Set(configuredOrigins.map((origin) => {
        const value = origin.trim();
        const url = new URL(value);
        if (url.origin !== value || !["http:", "https:"].includes(url.protocol)
            || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) {
            throw new Error("ALLOWED_ORIGINS must contain exact origins (HTTPS in production), without paths or trailing slashes.");
        }
        return value;
    }));
    const app = express();
    const server = http.createServer(app);
    let shuttingDown = false;
    function originAllowed(origin, request) {
        if (!origin) return true;
        try {
            const parsed = new URL(origin);
            if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
            return allowedOrigins.size ? allowedOrigins.has(origin) : parsed.host === request.headers.host;
        } catch { return false; }
    }
    function consume(buckets, key, count, windowMs) {
        const time = now();
        let bucket = buckets.get(key);
        if (!bucket || time >= bucket.until) {
            bucket = { used: 0, until: time + windowMs };
            buckets.set(key, bucket);
        }
        bucket.used += 1;
        return bucket.used <= count;
    }
    const io = new Server(server, {
        maxHttpBufferSize: 8192, perMessageDeflate: false,
        allowRequest(request, callback) {
            const ip = request.socket.remoteAddress;
            const permitted = !shuttingDown && originAllowed(request.headers.origin, request)
                && io.engine.clientsCount < limits.connections
                && (activeIps.get(ip) || 0) < limits.connectionsPerIp
                && (ipBuckets.has(ip) || ipBuckets.size < limits.sessions)
                && consume(ipBuckets, ip, 60, 60000);
            callback(null, permitted);
        },
        cors: { origin: (origin, callback) => callback(null, !!origin && allowedOrigins.has(origin)), credentials: false },
    });
    app.disable("x-powered-by");
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "..", "views"));
    app.use(helmet({
        strictTransportSecurity: process.env.NODE_ENV === "production" ? undefined : false,
        contentSecurityPolicy: { directives: {
            defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://server.arcgisonline.com",
                "https://*.tile.opentopomap.org", "https://*.basemaps.cartocdn.com"],
            connectSrc: ["'self'", ...new Set(Object.values(routes).map((url) => new URL(url).origin))],
            frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'none'"],
            upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
        } },
    }));
    app.use((req, res, next) => {
        res.set("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
        next();
    });
    app.use("/vendor/leaflet", express.static(path.join(path.dirname(require.resolve("leaflet/package.json")), "dist")));
    app.use("/vendor/markercluster", express.static(path.join(path.dirname(require.resolve("leaflet.markercluster/package.json")), "dist")));
    app.use(express.static(path.join(__dirname, "..", "public"), { dotfiles: "deny" }));
    app.get("/healthz", (req, res) => res.status(shuttingDown ? 503 : 200).json({ ok: !shuttingDown, storage: "ephemeral-single-process" }));
    app.get("/api/config", (req, res) => res.json({ routes, staleLocationMs: limits.staleLocationMs }));
    app.get("/", (req, res) => res.render("index"));
    app.get("/app", (req, res) => res.render("app"));
    app.use((req, res) => res.status(404).type("text").send("Not found"));
    app.use((error, req, res, next) => {
        console.error("HTTP request failed:", error.code || error.name);
        res.status(500).type("text").send("The request could not be completed.");
    });

    const channel = (code) => `room:${code}`;
    function publicMember(member) {
        return { id: member.id, name: member.name, connected: member.connected,
            sharing: member.sharing, location: member.location, joinedAt: member.joinedAt };
    }
    function snapshot(room) {
        return { roomCode: room.code, hostId: room.hostId, expiresAt: room.expiresAt,
            members: [...room.members.values()].map(publicMember),
            landmarks: [...room.pins.values()], messages: [...room.messages.values()] };
    }
    function broadcast(room) { io.to(channel(room.code)).emit("room-state", snapshot(room)); }
    function destroy(room, reason) {
        io.to(channel(room.code)).emit("room-closed", { roomCode: room.code, reason });
        io.in(channel(room.code)).socketsLeave(channel(room.code));
        for (const session of sessions.values()) if (session.roomCode === room.code) session.roomCode = null;
        rooms.delete(room.code);
    }
    function detach(session) {
        const code = session.roomCode;
        const room = rooms.get(code);
        if (room) {
            room.members.delete(session.id);
            if (room.members.size === 0) destroy(room, "The last member left.");
            else broadcast(room);
        }
        if (session.socketId && code) io.sockets.sockets.get(session.socketId)?.leave(channel(code));
        session.roomCode = null;
    }
    function current(session) {
        const room = rooms.get(session.roomCode);
        if (!room || now() >= room.expiresAt) {
            if (room) destroy(room, "This room has expired.");
            throw new Error("This room is closed or expired. Create a new room.");
        }
        const member = room.members.get(session.id);
        if (!member) throw new Error("Join a room first.");
        return { room, member };
    }
    io.use((socket, next) => {
        if (shuttingDown) return next(new Error("Server is restarting."));
        const token = socket.handshake.auth?.token;
        let session = typeof token === "string" && token.length === 64 ? sessions.get(token) : null;
        if (!session || now() - session.touchedAt > limits.sessionLifetimeMs) {
            if (sessions.size >= limits.sessions) return next(new Error("Server is busy. Try again later."));
            session = { token: crypto.randomBytes(32).toString("hex"), id: crypto.randomUUID(),
                roomCode: null, socketId: null, touchedAt: now(), buckets: new Map() };
            sessions.set(session.token, session);
        }
        socket.data.session = session;
        next();
    });
    io.on("connection", (socket) => {
        const session = socket.data.session;
        if (session.socketId && session.socketId !== socket.id) {
            io.sockets.sockets.get(session.socketId)?.emit("session-replaced");
            io.sockets.sockets.get(session.socketId)?.disconnect(true);
        }
        session.socketId = socket.id;
        session.touchedAt = now();
        const ip = socket.request.socket.remoteAddress;
        activeIps.set(ip, (activeIps.get(ip) || 0) + 1);
        socket.emit("session", { token: session.token, memberId: session.id });
        function on(event, count, windowMs, handler) {
            socket.on(event, (data, acknowledge) => {
                if (typeof data === "function" && acknowledge === undefined) { acknowledge = data; data = undefined; }
                const ack = typeof acknowledge === "function" ? acknowledge : () => {};
                try {
                    if (!consume(session.buckets, "all", 180, 10000)
                        || !consume(session.buckets, event, count, windowMs)
                        || !consume(ipBuckets, `${ip}:${event}`, count * 10, windowMs)) {
                        return ack({ ok: false, error: "Too many requests. Wait a moment and try again." });
                    }
                    session.touchedAt = now();
                    if (!isObject(data)) return ack({ ok: false, error: "Invalid event payload." });
                    ack({ ok: true, ...handler(data) });
                } catch (error) {
                    if (error instanceof TypeError || error instanceof ReferenceError) {
                        console.error(`Socket handler failed: ${event} (${error.name})`);
                        ack({ ok: false, error: "The request could not be completed." });
                    } else ack({ ok: false, error: error.message || "The request could not be completed." });
                }
            });
        }
        on("join-room", 12, 60000, (data) => {
            const name = text(data.displayName, 2, 30);
            if (!name) throw new Error("Name must be 2–30 characters.");
            if (!["create", "join", "resume"].includes(data.action)) throw new Error("Choose Create or Join.");
            let room;
            if (data.action === "create") {
                if (rooms.size >= limits.rooms) throw new Error("Room limit reached. Try again later.");
                let code;
                do { code = crypto.randomBytes(8).toString("hex").toUpperCase(); } while (rooms.has(code));
                room = { code, hostId: session.id, expiresAt: now() + limits.roomLifetimeMs,
                    members: new Map(), pins: new Map(), messages: new Map() };
            } else {
                const code = normalizeCode(data.roomCode);
                if (!validCode(code)) throw new Error("Enter a complete 16-character room code.");
                room = rooms.get(code);
                if (!room || now() >= room.expiresAt) {
                    if (room) destroy(room, "This room has expired.");
                    throw new Error("Room not found or expired. Check the invite or create a new room.");
                }
                if (!room.members.has(session.id) && room.members.size >= limits.members) throw new Error("This room is full.");
            }
            if (session.roomCode && session.roomCode !== room.code) detach(session);
            rooms.set(room.code, room);
            const previous = room.members.get(session.id);
            room.members.set(session.id, { id: session.id, name, connected: true, sharing: false,
                location: null, joinedAt: previous?.joinedAt || now(), disconnectedAt: null });
            session.roomCode = room.code;
            socket.join(channel(room.code));
            const state = snapshot(room);
            broadcast(room);
            return { memberId: session.id, snapshot: state };
        });
        on("send-location", 20, 10000, (data) => {
            const { room, member } = current(session);
            if (!validPosition(data) || typeof data.accuracy !== "number" || !Number.isFinite(data.accuracy)
                || data.accuracy < 0 || data.accuracy > 100000
                || typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)
                || Math.abs(now() - data.timestamp) > limits.staleLocationMs) throw new Error("Invalid or outdated location sample.");
            member.sharing = true;
            member.location = { latitude: data.latitude, longitude: data.longitude, accuracy: data.accuracy,
                timestamp: data.timestamp, receivedAt: now() };
            io.to(channel(room.code)).emit("receive-location", { roomCode: room.code, member: publicMember(member) });
            return {};
        });
        on("pause-location", 10, 10000, () => {
            const { room, member } = current(session);
            member.sharing = false; member.location = null; broadcast(room);
            return {};
        });
        on("add-landmark", 10, 60000, (data) => {
            const { room, member } = current(session);
            const label = text(data.label, 1, 50);
            if (!validPosition(data) || !label) throw new Error("Enter a valid pin name and location.");
            if (room.pins.size >= limits.pins) throw new Error("Pin limit reached. Remove a pin first.");
            const landmark = { id: crypto.randomUUID(), latitude: data.latitude, longitude: data.longitude,
                label, creatorId: session.id, creatorName: member.name,
                expiresAt: Math.min(room.expiresAt, now() + limits.pinLifetimeMs) };
            room.pins.set(landmark.id, landmark);
            io.to(channel(room.code)).emit("receive-landmark", { roomCode: room.code, landmark });
            return { landmark };
        });
        on("remove-landmark", 20, 10000, (data) => {
            const { room } = current(session);
            if (typeof data.id !== "string" || data.id.length > 64) throw new Error("Invalid pin.");
            const pin = room.pins.get(data.id);
            if (!pin || pin.creatorId !== session.id) throw new Error("Only the creator can remove this pin.");
            room.pins.delete(data.id);
            io.to(channel(room.code)).emit("landmark-removed", { roomCode: room.code, id: data.id });
            return {};
        });
        on("chat-message", 20, 10000, (data) => {
            const { room, member } = current(session);
            const message = text(data.message, 1, 240);
            if (!message || typeof data.messageId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(data.messageId)) throw new Error("Invalid message.");
            const key = `${session.id}:${data.messageId}`;
            if (room.messages.has(key)) return { message: room.messages.get(key) };
            const item = { messageId: key, id: session.id, name: member.name, message, sentAt: now() };
            room.messages.set(key, item);
            while (room.messages.size > limits.messages) room.messages.delete(room.messages.keys().next().value);
            io.to(channel(room.code)).emit("chat-message", { roomCode: room.code, message: item });
            return { message: item };
        });
        on("leave-room", 10, 10000, () => { detach(session); return {}; });
        on("close-room", 5, 10000, () => {
            const { room } = current(session);
            if (room.hostId !== session.id) throw new Error("Only the room creator can close it.");
            destroy(room, "The creator closed this room.");
            return {};
        });
        socket.on("disconnect", () => {
            const active = (activeIps.get(ip) || 1) - 1;
            if (active > 0) activeIps.set(ip, active); else activeIps.delete(ip);
            if (session.socketId !== socket.id) return;
            session.socketId = null; session.touchedAt = now();
            const room = rooms.get(session.roomCode);
            const member = room?.members.get(session.id);
            if (member) {
                member.connected = false; member.sharing = false;
                member.location = null; member.disconnectedAt = now(); broadcast(room);
            }
        });
    });
    function sweep() {
        const time = now();
        for (const room of rooms.values()) {
            if (time >= room.expiresAt) { destroy(room, "This room has expired."); continue; }
            let changed = false;
            for (const [id, member] of room.members) {
                if (!member.connected && time - member.disconnectedAt >= limits.reconnectGraceMs) {
                    room.members.delete(id); changed = true;
                } else if (member.location && time - member.location.receivedAt > limits.staleLocationMs) {
                    member.location = null; changed = true;
                }
            }
            for (const [id, pin] of room.pins) if (pin.expiresAt <= time) { room.pins.delete(id); changed = true; }
            if (room.members.size === 0) destroy(room, "All members disconnected.");
            else if (changed) broadcast(room);
        }
        for (const [token, session] of sessions) if (!session.socketId && time - session.touchedAt >= limits.sessionLifetimeMs) sessions.delete(token);
        for (const [key, bucket] of ipBuckets) if (time >= bucket.until) ipBuckets.delete(key);
    }
    const timer = setInterval(sweep, options.sweepIntervalMs || 5000);
    timer.unref();
    async function close() {
        shuttingDown = true; clearInterval(timer); io.emit("server-restarting");
        await new Promise((resolve) => io.close(resolve));
        rooms.clear(); sessions.clear(); ipBuckets.clear(); activeIps.clear();
    }
    return { app, server, io, rooms, sessions, limits, sweep, close };
}

module.exports = { createTrackingServer, DEFAULT_LIMITS };
