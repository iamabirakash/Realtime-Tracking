"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { io } = require("socket.io-client");
const { createTrackingServer } = require("../app");

async function setup(t, options = {}) {
    const instance = createTrackingServer(options);
    instance.server.listen(0, "127.0.0.1");
    await once(instance.server, "listening");
    const url = `http://127.0.0.1:${instance.server.address().port}`;
    t.after(() => instance.close());
    async function connect(token, extra = {}) {
        const socket = io(url, { autoConnect: false, reconnection: false, transports: ["websocket"], auth: { token }, ...extra });
        const session = new Promise((resolve, reject) => {
            socket.once("session", resolve); socket.once("connect_error", reject);
        });
        socket.connect();
        socket.identity = await session;
        return socket;
    }
    return { ...instance, url, connect };
}
function send(socket, event, data = {}) {
    return new Promise((resolve, reject) => socket.timeout(2500).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));
}
const create = (socket, name = "Alice") => send(socket, "join-room", { action: "create", displayName: name });
const join = (socket, roomCode, name = "Bob", action = "join") => send(socket, "join-room", { action, displayName: name, roomCode });
const position = () => ({ latitude: 12.97, longitude: 77.59, accuracy: 10, timestamp: Date.now() });

test("pages, security headers, local map assets, config, and manifest icons", async (t) => {
    const app = await setup(t);
    for (const path of ["/", "/app", "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css", "/vendor/leaflet/images/marker-icon.png", "/vendor/markercluster/leaflet.markercluster.js", "/api/config", "/healthz"]) {
        const response = await fetch(app.url + path);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
        assert.equal(response.headers.get("x-powered-by"), null);
        assert.match(response.headers.get("permissions-policy"), /geolocation=\(self\)/);
    }
    const manifest = await (await fetch(app.url + "/images/site.webmanifest")).json();
    assert.ok(manifest.name);
    for (const icon of manifest.icons) assert.equal((await fetch(app.url + icon.src)).status, 200);
    assert.equal((await fetch(app.url + "/.env")).status, 404);
    assert.equal((await fetch(app.url + "/missing")).status, 404);
});

test("malformed payloads cannot terminate the server", async (t) => {
    const app = await setup(t);
    const client = await app.connect();
    for (const event of ["join-room", "send-location", "add-landmark", "remove-landmark", "chat-message", "leave-room", "close-room", "pause-location"]) {
        for (const value of [null, [], "bad", 42]) assert.equal((await send(client, event, value)).ok, false, event);
    }
    assert.equal((await fetch(app.url + "/healthz")).status, 200);
});

test("missing payloads receive validation errors instead of hanging", async (t) => {
    const app = await setup(t);
    const client = await app.connect();
    const response = await new Promise((resolve, reject) => client.timeout(2000).emit("join-room", (error, value) => error ? reject(error) : resolve(value)));
    assert.equal(response.ok, false);
    assert.match(response.error, /payload/);
});

test("configured origins cannot silently contain paths or non-HTTP schemes", () => {
    for (const origin of ["https://example.com/path", "https://example.com/", "ftp://example.com"]) {
        assert.throws(() => createTrackingServer({ allowedOrigins: [origin] }), /exact origins/);
    }
});

test("creation is random and distinct; joining validates and requires an existing room", async (t) => {
    const app = await setup(t);
    const alice = await app.connect();
    assert.equal((await send(alice, "join-room", { action: "create", displayName: "a" })).ok, false);
    const first = await create(alice);
    assert.match(first.snapshot.roomCode, /^[A-F0-9]{16}$/);
    const bob = await app.connect();
    for (const code of ["", "AAA", "ABC!DEF1234567890", "F".repeat(17), "0".repeat(16)]) assert.equal((await join(bob, code)).ok, false);
    assert.equal((await join(bob, first.snapshot.roomCode.toLowerCase())).ok, true);
    const second = await create(alice);
    assert.notEqual(second.snapshot.roomCode, first.snapshot.roomCode);
    assert.equal(app.rooms.get(first.snapshot.roomCode).members.size, 1);
});

test("membership exists without GPS and the last explicit departure deletes all room data", async (t) => {
    const app = await setup(t);
    const alice = await app.connect(), bob = await app.connect();
    const { snapshot } = await create(alice);
    const joined = await join(bob, snapshot.roomCode);
    assert.equal(joined.snapshot.members.length, 2);
    assert.ok(joined.snapshot.members.every((member) => member.location === null));
    await send(alice, "send-location", position());
    await send(alice, "add-landmark", { latitude: 1, longitude: 2, label: "Meet here" });
    await send(alice, "leave-room");
    const room = app.rooms.get(snapshot.roomCode);
    assert.equal(room.members.size, 1);
    assert.equal(room.pins.size, 1);
    await send(bob, "leave-room");
    assert.equal(app.rooms.size, 0);
});

test("coordinates require numbers, accuracy and a fresh sample; pause removes position", async (t) => {
    const app = await setup(t);
    const alice = await app.connect();
    const { snapshot } = await create(alice);
    for (const invalid of [{ ...position(), latitude: null }, { ...position(), longitude: "" }, { ...position(), latitude: 91 }, { ...position(), accuracy: -1 }, { ...position(), timestamp: 0 }]) {
        assert.equal((await send(alice, "send-location", invalid)).ok, false);
    }
    assert.equal((await send(alice, "send-location", position())).ok, true);
    const member = app.rooms.get(snapshot.roomCode).members.get(alice.identity.memberId);
    assert.equal(member.location.accuracy, 10);
    assert.ok(member.location.receivedAt);
    assert.equal((await send(alice, "pause-location")).ok, true);
    assert.equal(member.location, null);
    assert.equal(member.sharing, false);
    assert.equal((await send(alice, "add-landmark", { latitude: null, longitude: "", label: "Bad" })).ok, false);
});

test("rooms isolate location, pins and messages", async (t) => {
    const app = await setup(t);
    const alice = await app.connect(), bob = await app.connect();
    await create(alice); await create(bob, "Bob");
    const seen = [];
    for (const event of ["receive-location", "receive-landmark", "chat-message"]) bob.on(event, () => seen.push(event));
    await send(alice, "send-location", position());
    await send(alice, "add-landmark", { latitude: 1, longitude: 2, label: "Private pin" });
    await send(alice, "chat-message", { messageId: "testmessage1", message: "Hello" });
    const state = await join(bob, [...app.rooms.values()].find((room) => room.hostId === bob.identity.memberId).code, "Bob");
    assert.equal(state.snapshot.messages.length, 0);
    assert.equal(state.snapshot.landmarks.length, 0);
    assert.equal(state.snapshot.members.length, 1);
    assert.deepEqual(seen, []);
});

test("pin ownership survives reconnect; another member cannot remove pins or close the room", async (t) => {
    const app = await setup(t);
    let alice = await app.connect(); const bob = await app.connect();
    const { snapshot } = await create(alice);
    await join(bob, snapshot.roomCode);
    const { landmark } = await send(alice, "add-landmark", { latitude: 1, longitude: 2, label: "Pin" });
    assert.equal((await send(bob, "remove-landmark", { id: landmark.id })).ok, false);
    assert.equal((await send(bob, "close-room")).ok, false);
    const identity = alice.identity;
    const disconnected = once(app.io.sockets.sockets.get(alice.id), "disconnect");
    alice.disconnect(); await disconnected;
    alice = await app.connect(identity.token);
    assert.equal(alice.identity.memberId, identity.memberId);
    const resumed = await join(alice, snapshot.roomCode, "Alice", "resume");
    assert.equal(resumed.snapshot.members.length, 2);
    assert.equal(resumed.snapshot.landmarks[0].creatorId, identity.memberId);
    assert.equal((await send(alice, "remove-landmark", { id: landmark.id })).ok, true);
    assert.equal((await send(alice, "close-room")).ok, true);
    assert.equal(app.rooms.size, 0);
    assert.equal((await join(bob, snapshot.roomCode)).ok, false, "closed invites cannot resurrect a room");
});

test("server tokens cannot be chosen to impersonate another room member", async (t) => {
    const app = await setup(t);
    const alice = await app.connect();
    const attacker = await app.connect("a".repeat(64));
    assert.notEqual(attacker.identity.memberId, alice.identity.memberId);
    assert.notEqual(attacker.identity.token, "a".repeat(64));
});

test("chat acknowledgements deduplicate retries and history is bounded", async (t) => {
    const app = await setup(t, { limits: { messages: 3 } });
    const alice = await app.connect(); const { snapshot } = await create(alice);
    const message = { messageId: "retrymessage", message: "Hello <world>" };
    const first = await send(alice, "chat-message", message);
    const retry = await send(alice, "chat-message", message);
    assert.deepEqual(retry.message, first.message);
    for (let i = 0; i < 5; i++) assert.equal((await send(alice, "chat-message", { messageId: `message_${i}`, message: `${i}` })).ok, true);
    assert.equal(app.rooms.get(snapshot.roomCode).messages.size, 3);
    assert.equal((await send(alice, "chat-message", { messageId: "badlongmessage", message: "x".repeat(241) })).ok, false);
});

test("room and pin caps and event rates are enforced", async (t) => {
    const app = await setup(t, { limits: { rooms: 1, members: 1, pins: 1 } });
    const alice = await app.connect(), bob = await app.connect();
    const { snapshot } = await create(alice);
    assert.equal((await create(bob, "Bob")).ok, false);
    assert.equal((await join(bob, snapshot.roomCode)).ok, false);
    assert.equal((await send(alice, "add-landmark", { latitude: 1, longitude: 2, label: "First" })).ok, true);
    assert.equal((await send(alice, "add-landmark", { latitude: 1, longitude: 2, label: "Second" })).ok, false);
    let rejected = false;
    for (let i = 0; i < 22; i++) if (!(await send(alice, "send-location", position())).ok) rejected = true;
    assert.equal(rejected, true);
});

test("expiry, stale locations, disconnect grace, and session cleanup use bounded lifetimes", async (t) => {
    let time = Date.now();
    const app = await setup(t, { now: () => time, limits: { pinLifetimeMs: 50, staleLocationMs: 100, reconnectGraceMs: 200, roomLifetimeMs: 1000, sessionLifetimeMs: 2000 } });
    const alice = await app.connect(); const { snapshot } = await create(alice);
    await send(alice, "send-location", position());
    await send(alice, "add-landmark", { latitude: 1, longitude: 2, label: "Temporary" });
    const room = app.rooms.get(snapshot.roomCode);
    time += 101; app.sweep();
    assert.equal(room.pins.size, 0);
    assert.equal(room.members.get(alice.identity.memberId).location, null);
    const disconnected = once(app.io.sockets.sockets.get(alice.id), "disconnect");
    alice.disconnect(); await disconnected;
    assert.equal(app.rooms.size, 1);
    time += 201; app.sweep(); assert.equal(app.rooms.size, 0);
    time += 2001; app.sweep(); assert.equal(app.sessions.size, 0);
    const bob = await app.connect(); const created = await create(bob, "Bob");
    time += 1001; app.sweep();
    assert.equal(app.rooms.has(created.snapshot.roomCode), false);
});

test("foreign and null WebSocket origins are rejected; same origin is allowed", async (t) => {
    const app = await setup(t);
    for (const origin of ["https://unrelated.example", "null"]) {
        await assert.rejects(app.connect(undefined, { extraHeaders: { Origin: origin } }));
    }
    const client = await app.connect(undefined, { extraHeaders: { Origin: app.url } });
    assert.ok(client.connected);
});
