const express = require('express');
const app = express();

const socketio = require("socket.io"); //it require HTTP server

const server = http.createServer(app);

const io = socketio(server);

app.set("view engine","ejs");
app.set(express.static(path.join(__dirname,"public")));

app.get("/", function(req,res){
    res.send("Hey");
});

server.listen(3000);