"use strict";

const { chromium } = require("playwright");
const { io } = require("socket.io-client");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createTrackingServer } = require("../app");

(async () => {
    const app = createTrackingServer();
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    const url = `http://127.0.0.1:${app.server.address().port}`;
    let browser, peer;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["geolocation"], geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 15 } });
        const page = await context.newPage();
        const errors = [];
        let loadedTiles = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => { if (/tile\.openstreetmap/.test(response.url()) && response.status() === 200) loadedTiles += 1; });
        await page.goto(url + "/app");
        await page.locator("#display-name").fill("Priya Shah");
        await page.locator("#share-on-join").check();
        await page.locator("#create-room").click();
        await page.locator("#room-panel").waitFor({ state: "hidden" });
        const roomCode = await page.locator("#room-name").textContent();
        peer = io(url, { autoConnect: false, transports: ["websocket"] });
        const session = once(peer, "session"); peer.connect(); await session;
        const send = (event, data) => new Promise((resolve) => peer.emit(event, data, resolve));
        await send("join-room", { action: "join", roomCode, displayName: "Alex Chen" });
        await send("send-location", { latitude: 12.9742, longitude: 77.6004, accuracy: 10, timestamp: Date.now() });
        await send("chat-message", { messageId: "preview_hello", message: "I'm near the meeting point. See you soon!" });
        await page.waitForTimeout(1000);
        await page.locator("#fit-all-btn").click();
        await page.waitForTimeout(1000);
        await page.locator("#landmark-btn").click();
        page.once("dialog", (dialog) => dialog.accept("Meeting point"));
        await page.locator("#map").click({ position: { x: 500, y: 420 } });
        await page.waitForTimeout(2000);
        const directory = path.join(__dirname, "..", "test-results"); await fs.mkdir(directory, { recursive: true });
        await page.screenshot({ path: path.join(directory, "live-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await page.locator("#fit-all-btn").click(); await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(directory, "live-phone.png") });
        await page.locator("#sheet-chevron").click(); await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(directory, "live-phone-expanded.png") });
        const layout = await page.evaluate(() => ({ scrollY, profileTop: document.getElementById("you-chip").getBoundingClientRect().top }));
        console.log(JSON.stringify({ loadedTiles, errors, layout, screenshots: ["live-desktop.png", "live-phone.png", "live-phone-expanded.png"] }));
        if (layout.scrollY || layout.profileTop < 0) throw new Error("Responsive preview scrolled outside its viewport");
        if (!loadedTiles || errors.length) process.exitCode = 1;
    } finally {
        peer?.disconnect(); if (browser) await browser.close(); await app.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
