const express = require('express');
const app = express();

const socketio = require("socket.io"); //it require HTTP server

const server = http.createServer(app);

const io = socketio(server);

app.get("/", function(req,res){
    res.send("Hey");
});

server.listen(3000);