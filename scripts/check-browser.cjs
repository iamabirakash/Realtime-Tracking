"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { io } = require("socket.io-client");
const { createTrackingServer } = require("../app");

const resultDirectory = path.join(__dirname, "..", "test-results");
const widths = [240, 280, 320, 360, 390, 414, 480, 600, 768, 899, 900, 1024, 1280, 1440, 1920, 2560, 3840];
const sizes = widths.map((width) => ({ width, height: width < 600 ? 844 : 900 }));
sizes.push({ width: 640, height: 360 }, { width: 844, height: 390 }, { width: 900, height: 540 }, { width: 1280, height: 400 });
const transparentTile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=", "base64");
const send = (client, event, data = {}) => new Promise((resolve, reject) => client.timeout(4000).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));
async function poll(check, description) {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error(`Timed out: ${description}`);
}
async function prepare(context, { blockStorage = false, roomName = "Reviewer" } = {}) {
    const page = await context.newPage();
    const errors = [];
    const tileRequests = [];
    page.on("request", (request) => {
        if (request.url().startsWith("https://tile.openstreetmap.org/")) tileRequests.push(request);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && /Content Security Policy|violates.*directive/i.test(message.text())) errors.push(message.text()); });
    await page.addInitScript(({ blocked, name }) => {
        window.testWatches = 0; window.testClears = 0;
        Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
            watchPosition(success) {
                const id = ++window.testWatches;
                setTimeout(() => success({ coords: { latitude: 12.9716, longitude: 77.5946, accuracy: 12 }, timestamp: Date.now() }), 20);
                return id;
            },
            clearWatch() { window.testClears += 1; },
        } });
        if (blocked) for (const method of ["getItem", "setItem", "removeItem"]) Storage.prototype[method] = () => { throw new DOMException("Storage blocked", "SecurityError"); };
        window.testRoomName = name;
    }, { blocked: blockStorage, name: roomName });
    // Keep layout tests independent of tile-provider connectivity. App JS/CSS are real local assets.
    await page.route(/https:\/\/.*(?:tile\.openstreetmap|arcgisonline|tile\.opentopomap|basemaps\.cartocdn).*/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: transparentTile }));
    return { page, errors, tileRequests };
}
async function assertLayout(page, state, size) {
    await page.waitForTimeout(100);
    await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity));
    const result = await page.evaluate(() => {
        const issues = [];
        if (scrollY !== 0 || scrollX !== 0) issues.push(`page unexpectedly scrolled ${scrollX},${scrollY}`);
        if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`document overflow ${document.documentElement.scrollWidth}/${innerWidth}`);
        const dialog = document.getElementById("room-panel");
        if (!dialog.hidden) {
            const rect = document.querySelector(".onboarding-card").getBoundingClientRect();
            if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) issues.push("onboarding outside viewport");
            if (document.querySelector(".onboarding-card").scrollWidth > document.querySelector(".onboarding-card").clientWidth + 1) issues.push("onboarding horizontal overflow");
        } else {
            for (const id of ["you-chip", "locate-btn", "landmark-btn", "fit-all-btn", "share-location"]) {
                const node = document.getElementById(id), rect = node.getBoundingClientRect();
                if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) issues.push(`${id} outside viewport: ${Math.round(rect.top)}..${Math.round(rect.bottom)}`);
            }
            const map = document.getElementById("map").getBoundingClientRect();
            if (map.width < 100 || map.height < 100) issues.push("map viewport too small");
            const attribution = document.querySelector(".leaflet-control-attribution").getBoundingClientRect();
            const sheet = document.getElementById("sheet").getBoundingClientRect();
            if (innerWidth < 900 && attribution.bottom > sheet.top + 2) issues.push(`map attribution hidden by sheet (${attribution.bottom.toFixed(1)} > ${sheet.top.toFixed(1)}, visual=${getComputedStyle(document.documentElement).getPropertyValue("--sheet-visual")}, peek=${getComputedStyle(document.documentElement).getPropertyValue("--sheet-peek")})`);
            if (document.getElementById("sheet").scrollWidth > document.getElementById("sheet").clientWidth + 1) issues.push("sheet horizontal overflow");
        }
        return issues;
    });
    assert.deepEqual(result, [], `${state} ${size.width}×${size.height}: ${result.join(", ")}`);
}
async function audit(page, name) {
    if (!await page.evaluate(() => typeof window.axe !== "undefined")) {
        const axeSource = await fs.readFile(require.resolve("axe-core/axe.min.js"));
        await page.route("**/__test/axe.js", (route) => route.fulfill({ contentType: "application/javascript", body: axeSource }));
        await page.addScriptTag({ url: new URL("/__test/axe.js", page.url()).href });
    }
    const result = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map((issue) => ({ id: issue.id, impact: issue.impact, nodes: issue.nodes.map((node) => node.target) })));
    await fs.writeFile(path.join(resultDirectory, `accessibility-${name}.json`), JSON.stringify(result, null, 2));
    assert.deepEqual(result, [], `Accessibility ${name}: ${JSON.stringify(result)}`);
}

(async () => {
    await fs.mkdir(resultDirectory, { recursive: true });
    const app = createTrackingServer();
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    const url = `http://127.0.0.1:${app.server.address().port}`;
    let browser, activePage;
    const clients = [];
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const { page, errors, tileRequests } = await prepare(context); activePage = page;
        await page.goto(url + "/app?room=0123456789ABCDEF");
        await page.waitForFunction(() => document.getElementById("connection-status").textContent === "Ready to join");
        assert.equal(await page.evaluate(() => window.testWatches), 0, "GPS must not start on page load");
        await poll(() => tileRequests.length > 0, "OpenStreetMap tile requests");
        for (const request of tileRequests) {
            const headers = await request.allHeaders();
            assert.equal(headers.referer, url + "/", "Tiles identify only the site origin, without the room code or page path");
            assert.equal(new URL(request.url()).hostname, "tile.openstreetmap.org", "Use the canonical OSM tile endpoint");
        }
        await audit(page, "onboarding");
        for (const size of sizes) { await page.setViewportSize(size); await assertLayout(page, "onboarding", size); }
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator("#room-code").fill("");
        await page.locator("#display-name").fill("Reviewer");
        assert.equal(await page.locator("#join-room").isDisabled(), true, "Join requires a complete code");
        await page.locator("#create-room").click();
        await page.locator("#room-panel").waitFor({ state: "hidden" });
        const code = (await page.locator("#room-name").textContent()).trim();
        assert.match(code, /^[A-F0-9]{16}$/);
        assert.equal(await page.evaluate(() => window.testWatches), 0, "joining without consent must not start GPS");
        await poll(async () => await page.locator("#member-count").textContent() === "1", "initial member render");
        assert.equal(await page.locator("#avatar-row button").count(), 1);
        assert.equal(await page.evaluate(() => { document.getElementById("display-name").focus(); return document.activeElement.id === "display-name"; }), false, "hidden onboarding cannot receive focus");

        const attacker = io(url, { autoConnect: false, transports: ["websocket"], reconnection: false }); clients.push(attacker);
        const identityPromise = once(attacker, "session"); attacker.connect(); await identityPromise;
        const unsafeName = "<img src=x onerror=xss=1>";
        assert.equal((await send(attacker, "join-room", { action: "join", roomCode: code, displayName: unsafeName })).ok, true);
        await poll(async () => await page.locator("#member-count").textContent() === "2", "membership without GPS");
        assert.equal(await page.locator("#avatar-row button").count(), 2);
        assert.equal((await send(attacker, "send-location", { latitude: 13.2, longitude: 77.7, accuracy: 10, timestamp: Date.now() })).ok, true);
        await page.locator("#share-location").click();
        await poll(async () => [...app.rooms.get(code).members.values()].some((member) => member.name === "Reviewer" && member.location), "location sharing");
        assert.equal(await page.evaluate(() => window.testWatches), 1);
        await page.getByRole("button", { name: new RegExp("^" + unsafeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
        await page.waitForTimeout(450);
        await page.getByAltText(`Location of ${unsafeName}`, { exact: true }).hover();
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.xss), undefined);
        assert.equal(await page.locator(".leaflet-tooltip img").count(), 0);
        assert.equal(await page.locator(".leaflet-tooltip").textContent(), unsafeName);

        // A response that arrives after Hide route must not draw anything.
        let releaseRoute, routeStarted;
        const started = new Promise((resolve) => { routeStarted = resolve; });
        const release = new Promise((resolve) => { releaseRoute = resolve; });
        await page.route(/https:\/\/.*\/route\/v1\//, async (route) => {
            routeStarted(); await release;
            await route.fulfill({ json: { routes: [{ geometry: { coordinates: [[77.5946, 12.9716], [77.7, 13.2]] }, distance: 1000, duration: 300 }] } }).catch(() => {});
        });
        await page.getByRole("button", { name: "Show route", exact: true }).click();
        await started;
        await page.getByRole("button", { name: "Hide route", exact: true }).click(); releaseRoute();
        await page.waitForTimeout(300);
        assert.equal(await page.locator(".leaflet-overlay-pane path").count(), 0);
        await page.unroute(/https:\/\/.*\/route\/v1\//);
        await page.locator(".leaflet-popup-close-button").click();

        await page.locator("#chat-input").fill("Hello from the regression test");
        await page.locator("#chat-send").click();
        await page.waitForFunction(() => document.getElementById("chat-feedback").textContent === "Delivered");
        assert.equal(await page.locator("#chat-input").inputValue(), "");
        assert.equal(await page.locator(".chat-message-bubble").textContent(), "Hello from the regression test");

        await page.locator("#landmark-btn").click();
        page.once("dialog", (dialog) => dialog.accept("Our meeting point"));
        await page.locator("#map").click({ position: { x: 300, y: 330 } });
        await poll(() => [...app.rooms.get(code).pins.values()].some((pin) => pin.label === "Our meeting point"), "own pin creation");
        const ownPin = [...app.rooms.get(code).pins.values()].find((pin) => pin.label === "Our meeting point");
        const ownId = ownPin.creatorId;
        const remotePin = await send(attacker, "add-landmark", { latitude: 13.199, longitude: 77.699, label: "Remove while offline" });
        await context.setOffline(true);
        await page.waitForFunction(() => document.getElementById("connection-status").textContent.includes("Offline"));
        await poll(() => !app.rooms.get(code).members.get(ownId).connected, "server disconnect");
        assert.equal(await page.locator(".leaflet-marker-icon").count(), 0, "stale map markers clear offline");
        assert.equal((await send(attacker, "remove-landmark", { id: remotePin.landmark.id })).ok, true);
        await send(attacker, "chat-message", { messageId: "offline_message", message: "Sent while you were away" });
        await context.setOffline(false);
        await poll(async () => await page.locator("#member-count").textContent() === "2" && await page.locator("#connection-status").textContent() === "Connected", "reconnect snapshot");
        assert.equal(app.rooms.get(code).members.has(ownId), true);
        assert.equal(await page.getByAltText("Shared pin: Remove while offline").count(), 0);
        assert.equal(await page.locator(".chat-message-bubble").count(), 2);
        assert.equal(await page.locator("#avatar-row button").count(), 2, "no ghost member after reconnect");
        await page.getByAltText("Shared pin: Our meeting point").focus();
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Remove pin", exact: true }).click();
        await poll(() => !app.rooms.get(code).pins.has(ownPin.id), "ownership survives reconnect");

        await page.locator("#share-location").click();
        await poll(() => app.rooms.get(code).members.get(ownId).location === null, "pause removes position");
        assert.ok(await page.evaluate(() => window.testClears) >= 1);
        await send(attacker, "join-room", { action: "join", roomCode: code, displayName: "Teammate" });
        await send(attacker, "send-location", { latitude: 13.2, longitude: 77.7, accuracy: 10, timestamp: Date.now() });
        await audit(page, "room-desktop");
        for (const size of sizes) {
            await page.setViewportSize(size);
            if (size.width < 900) {
                if (await page.locator("#sheet-chevron").getAttribute("aria-expanded") === "true") await page.locator("#sheet-chevron").click();
                await assertLayout(page, "room-peek", size);
                await page.locator("#sheet-chevron").click(); await assertLayout(page, "room-expanded", size);
            } else await assertLayout(page, "room-dock", size);
            await page.locator("#you-chip").click();
            const menuUsable = await page.locator("#menu-leave").evaluate((button) => {
                const rect = button.getBoundingClientRect();
                const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
                return rect.x >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && (target === button || button.contains(target));
            });
            assert.equal(menuUsable, true, `Room menu usable at ${size.width}×${size.height}`);
            await page.keyboard.press("Escape");
            if ([280, 390, 768, 900, 1440, 3840].includes(size.width)) await page.screenshot({ path: path.join(resultDirectory, `room-${size.width}x${size.height}.png`) });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        if (await page.locator("#sheet-chevron").getAttribute("aria-expanded") === "false") await page.locator("#sheet-chevron").click();
        await page.getByRole("tab", { name: "Chat", exact: true }).focus();
        await page.keyboard.press("ArrowLeft");
        assert.equal(await page.getByRole("tab", { name: "Members", exact: true }).getAttribute("aria-selected"), "true");
        await page.locator("#fit-all-btn").click();
        await assertLayout(page, "resized-phone-after-map-action", { width: 390, height: 844 });
        const handle = await page.locator("#sheet-handle").boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 15);
        await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2, handle.y + 155, { steps: 8 }); await page.mouse.up();
        assert.equal(await page.locator("#sheet").getAttribute("data-state"), "peek", "drag down collapses");
        await page.waitForTimeout(370);
        const collapsedHandle = await page.locator("#sheet-handle").boundingBox();
        await page.mouse.move(collapsedHandle.x + collapsedHandle.width / 2, collapsedHandle.y + 15);
        await page.mouse.down(); await page.mouse.move(collapsedHandle.x + collapsedHandle.width / 2, collapsedHandle.y - 125, { steps: 8 }); await page.mouse.up();
        assert.equal(await page.locator("#sheet").getAttribute("data-state"), "expanded", "drag up expands");
        await page.waitForTimeout(370);
        await audit(page, "room-phone");
        assert.deepEqual(errors, [], "No unhandled browser or CSP errors");
        console.log(`PASS: room security, opt-in sharing, delivery, reconnect, ownership, accessibility, and ${sizes.length} responsive viewports.`);

        const blockedContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
        const blocked = await prepare(blockedContext, { blockStorage: true }); activePage = blocked.page;
        await blocked.page.goto(url + "/app");
        await blocked.page.locator("#display-name").fill("Storage blocked");
        await blocked.page.locator("#create-room").click();
        await blocked.page.locator("#room-panel").waitFor({ state: "hidden" });
        assert.deepEqual(blocked.errors, []);
        console.log("PASS: blocked browser storage does not prevent room creation.");

        const landing = await context.newPage(); activePage = landing;
        await landing.goto(url);
        for (const width of widths) {
            await landing.setViewportSize({ width, height: 900 });
            assert.ok(await landing.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Landing overflow at ${width}px`);
        }
        await fs.writeFile(path.join(resultDirectory, "summary.json"), JSON.stringify({ ok: true, viewports: sizes, serverTests: "Run npm test", browser: browser.version(), externalTiles: "stubbed for deterministic layout checks", physicalDevices: "not tested" }, null, 2));
        console.log("PASS: landing page fits all tested widths.");
    } catch (error) {
        if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(resultDirectory, "failure.png") }).catch(() => {});
        throw error;
    } finally {
        for (const client of clients) client.disconnect();
        if (browser) await browser.close();
        await app.close();
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
