const express = require("express");
const path = require("path");
const http = require("http");
const socketio = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", function (socket) {
    socket.on("send-location", function (data = {}) {
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

        io.emit("receive-location", { id: socket.id, latitude, longitude });
    });

    socket.on("disconnect", function () {
        io.emit("user-disconnected", socket.id);
    });
});

app.get("/", function (req, res) {
    res.render("index");
});

server.listen(PORT, function () {
    console.log(`Server is running at http://localhost:${PORT}`);
});
