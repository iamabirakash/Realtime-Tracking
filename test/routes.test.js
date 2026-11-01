"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRouteController } = require("../public/js/route-controller");
const origin = { latitude: 1, longitude: 2 }, target = { latitude: 3, longitude: 4 };
const response = (coords = [[2, 1], [4, 3]]) => ({ ok: true, json: async () => ({ routes: [{ geometry: { coordinates: coords }, distance: 100, duration: 10 }] }) });
function harness(request, timeoutMs) {
    const routes = [], statuses = [];
    const controller = createRouteController({ request, timeoutMs, onRoute: (...args) => routes.push(args), onClear() {}, onStatus: (status) => statuses.push(status) });
    return { controller, routes, statuses };
}
test("a cancelled route cannot reappear when its fetch finishes", async () => {
    let resolve;
    const { controller, routes } = harness(() => new Promise((done) => { resolve = done; }));
    const pending = controller.calculate(origin, target, "https://routing.example/route");
    controller.clear(); resolve(response()); await pending;
    assert.equal(routes.length, 0);
});
test("out-of-order route responses cannot replace the latest selection", async () => {
    const resolvers = [];
    const { controller, routes } = harness(() => new Promise((done) => resolvers.push(done)));
    const old = controller.calculate(origin, target, "https://routing.example/route");
    const latest = controller.calculate(origin, { latitude: 5, longitude: 6 }, "https://routing.example/route");
    resolvers[1](response([[2, 1], [6, 5]])); await latest;
    resolvers[0](response()); await old;
    assert.deepEqual(routes.map(([points]) => points), [[[1, 2], [5, 6]]]);
});
test("invalid route coordinates fall back to a clearly identified straight line", async () => {
    const { controller, routes, statuses } = harness(async () => response([[2, 1000], [4, 3]]));
    await controller.calculate(origin, target, "https://routing.example/route");
    assert.equal(routes[0][1].direct, true);
    assert.match(statuses.at(-1), /not a travel route/);
});
test("timed out routing requests finish with an estimate instead of hanging", async () => {
    const { controller, routes } = harness((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Abort")))), 15);
    await controller.calculate(origin, target, "https://routing.example/route");
    assert.equal(routes[0][1].direct, true);
});
