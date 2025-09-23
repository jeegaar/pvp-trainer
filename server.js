const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {}; // { roomId: { players: [], nick: {} } }

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { players: [], nick: {} };
  }
}

function broadcastRooms() {
  const activeRooms = Object.entries(rooms)
    .filter(([_, r]) => r.players.length > 0)
    .map(([id, r]) => ({
      roomId: id,
      players: r.players.map(pid => r.nick[pid] || "Unknown")
    }));
  io.emit("roomsUpdate", activeRooms);
}

io.on("connection", (socket) => {
  console.log("✅ Client connected", socket.id);

  // CREATE ROOM
  socket.on("createRoom", ({ roomId, nickname }, cb) => {
    ensureRoom(roomId);
    const room = rooms[roomId];

    if (room.players.length > 0) {
      return cb({ success: false, message: "Room ID already taken" });
    }

    room.players.push(socket.id);
    room.nick[socket.id] = nickname;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    console.log(`🎮 Room created: ${roomId} by ${nickname}`);
    cb({ success: true });
    broadcastRooms();
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ roomId, nickname }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ success: false, message: "Room does not exist" });
    if (room.players.length >= 2) return cb({ success: false, message: "Room is full" });

    room.players.push(socket.id);
    room.nick[socket.id] = nickname;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nickname = nickname;

    console.log(`👤 ${nickname} joined room ${roomId}`);

    if (room.players.length === 2) {
      io.to(roomId).emit("roomReady", {
        players: room.players.map((id) => ({ id, nickname: room.nick[id] }))
      });
    }

    cb({ success: true });
    broadcastRooms();
  });

  // === RELAYS ===
  socket.on("playerMove", ({ roomId, x, y }) => {
    socket.to(roomId).emit("updateOpponentPosition", { x, y });
  });

  socket.on("castRune", ({ roomId, type, targetX, targetY }) => {
    socket.to(roomId).emit("opponentCastRune", { type, targetX, targetY });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    room.players = room.players.filter((id) => id !== socket.id);
    delete room.nick[socket.id];
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
