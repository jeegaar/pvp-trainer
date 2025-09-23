const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {}; // { roomId: { players: [], nick: {}, state: {...} } }

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],
      nick: {},
      state: { score: {}, pos: {}, next: {}, hp: {}, ready: {} }
    };
  }
}

function broadcastRooms() {
  const activeRooms = Object.entries(rooms)
    .filter(([_, r]) => r.players.length > 0) // only active rooms
    .map(([id, r]) => ({
      roomId: id,
      players: r.players.map(pid => r.nick[pid] || "Unknown")
    }));
  console.log("Active rooms:", activeRooms); // DEBUG
  io.emit("roomsUpdate", activeRooms);
}

io.on("connection", (socket) => {
  console.log("✅ New client connected", socket.id);

  // === CREATE ROOM ===
  socket.on("createRoom", ({ roomId, nickname }, cb) => {
    if (!roomId || !nickname) return cb({ success: false, message: "Missing room or nickname" });
    ensureRoom(roomId);
    const room = rooms[roomId];

    if (room.players.length > 0) {
      return cb({ success: false, message: "Room ID already taken" });
    }

    room.players.push(socket.id);
    room.nick[socket.id] = nickname;
    room.state.score[socket.id] = 0;
    room.state.hp[socket.id] = 100;
    room.state.ready[socket.id] = false;

    socket.join(roomId);
    socket.data.roomId = roomId;

    console.log(`🎮 Room created: ${roomId} by ${nickname}`);
    cb({ success: true });
    broadcastRooms();
  });

  // === JOIN ROOM ===
  socket.on("joinRoom", ({ roomId, nickname }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ success: false, message: "Room does not exist" });
    if (room.players.length >= 2) return cb({ success: false, message: "Room is full" });

    room.players.push(socket.id);
    room.nick[socket.id] = nickname;
    room.state.score[socket.id] = 0;
    room.state.hp[socket.id] = 100;
    room.state.ready[socket.id] = false;

    socket.join(roomId);
    socket.data.roomId = roomId;

    console.log(`👤 ${nickname} joined room ${roomId}`);

    if (room.players.length === 2) {
      io.to(roomId).emit("roomReady", {
        players: room.players.map((id) => ({ id, nickname: room.nick[id] }))
      });
    }

    cb({ success: true });
    broadcastRooms();
  });

  // === GET ROOMS (initial request) ===
  socket.on("getRooms", (cb) => {
    const activeRooms = Object.entries(rooms)
      .filter(([_, r]) => r.players.length > 0)
      .map(([id, r]) => ({
        roomId: id,
        players: r.players.map(pid => r.nick[pid] || "Unknown")
      }));
    cb(activeRooms);
  });

  // === DISCONNECT ===
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    room.players = room.players.filter((id) => id !== socket.id);
    delete room.nick[socket.id];
    delete room.state.score[socket.id];
    delete room.state.hp[socket.id];
    delete room.state.ready[socket.id];

    socket.to(roomId).emit("opponentLeft");

    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`🗑️ Room ${roomId} removed (empty)`);
    }

    broadcastRooms();
    console.log("❌ Client disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
