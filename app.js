"use strict";

const { createTrackingServer } = require("./server/tracking-server");

if (require.main === module) {
    if (Number(process.env.WEB_CONCURRENCY || 1) !== 1 || require("node:cluster").isWorker) {
        throw new Error("Pingroom uses ephemeral single-process storage. Run exactly one worker/replica.");
    }
    if (process.env.NODE_ENV === "production" && !process.env.ALLOWED_ORIGINS) {
        throw new Error("Set ALLOWED_ORIGINS to the public HTTPS origin in production.");
    }
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT.");
    const instance = createTrackingServer();
    instance.server.listen(port, process.env.HOST || "0.0.0.0", () => {
        console.log(`Pingroom listening on http://localhost:${instance.server.address().port}`);
    });
    instance.server.on("error", (error) => {
        console.error("Server could not start:", error.code || error.message);
        process.exitCode = 1;
        void instance.close();
    });
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        const deadline = setTimeout(() => process.exit(1), 8000);
        deadline.unref();
        instance.close().then(() => clearTimeout(deadline));
    });
}

module.exports = { createTrackingServer };
