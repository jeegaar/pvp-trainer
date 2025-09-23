const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

/**
 * rooms = {
 *   [roomId]: {
 *     players: [socketId1, socketId2?],
 *     nick: { socketId: "name" },
 *     state: {
 *       score: { socketId: 0 },
 *       pos:   { socketId: { x, y } },
 *       next:  { socketId: { x, y } | null }, // moving target during 100ms move
 *       hp:    { socketId: number },          // 0..100
 *       ready: { socketId: boolean }
 *     }
 *   }
 * }
 */
const rooms = {};

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],
      nick: {},
      state: { score: {}, pos: {}, next: {}, hp: {}, ready: {} }
    };
  }
}

function roomHasSpace(roomId) {
  return rooms[roomId].players.length < 2;
}

function opponentOf(room, me) {
  return room.players.find((id) => id !== me);
}

function randomSpawn() {
  return { x: Math.floor(Math.random() * 16), y: Math.floor(Math.random() * 16) };
}

function broadcastRoom(roomId, event, payload) {
  io.to(roomId).emit(event, payload);
}

io.on("connection", (socket) => {
  // ===== LOBBY: create / join =====
  socket.on("createRoom", ({ roomId, nickname }, cb) => {
    if (!roomId || !nickname) return cb({ success: false, message: "Missing room or nickname" });
    ensureRoom(roomId);
    const room = rooms[roomId];

    // "taken" = someone is inside. We reset rooms when empty automatically on disconnect.
    if (room.players.length > 0) {
      return cb({ success: false, message: "Room ID already taken" });
    }

    room.players.push(socket.id);
    room.nick[socket.id] = nickname;
    room.state.score[socket.id] = 0;
    room.state.pos[socket.id] = randomSpawn();
    room.state.next[socket.id] = null;
    room.state.hp[socket.id] = 100;
    room.state.ready[socket.id] = false;

    socket.join(roomId);
    socket.data.roomId = roomId;
    cb({ success: true });
  });

  socket.on("joinRoom", ({ roomId, nickname }, cb) => {
    if (!roomId || !nickname) return cb({ success: false, message: "Missing room or nickname" });
    const room = rooms[roomId];
    if (!room) return cb({ success: false, message: "Room does not exist" });
    if (!roomHasSpace(roomId)) return cb({ success: false, message: "Room is full" });

    room.players.push(socket.id);
    room.nick[socket.id] = nickname;
    room.state.score[socket.id] = 0;
    room.state.pos[socket.id] = randomSpawn();
    room.state.next[socket.id] = null;
    room.state.hp[socket.id] = 100;
    room.state.ready[socket.id] = false;

    socket.join(roomId);
    socket.data.roomId = roomId;

    // If room now has 2 players, notify both that lobby is ready
    if (room.players.length === 2) {
      broadcastRoom(roomId, "roomReady", {
        players: room.players.map((id) => ({ id, nickname: room.nick[id] }))
      });
    }
    cb({ success: true });
  });

  // ===== GAME PAGE: enter & readiness =====
  socket.on("enterGame", ({ roomId, nickname }, cb) => {
    // If player hit game.html directly (no lobby), try to attach them
    ensureRoom(roomId);
    const room = rooms[roomId];
    if (!room.players.includes(socket.id)) {
      if (!roomHasSpace(roomId)) return cb && cb({ success: false, message: "Room is full" });
      room.players.push(socket.id);
      room.nick[socket.id] = nickname || `Player-${socket.id.slice(0, 4)}`;
      room.state.score[socket.id] = room.state.score[socket.id] ?? 0;
      room.state.pos[socket.id] = room.state.pos[socket.id] || randomSpawn();
      room.state.next[socket.id] = null;
      room.state.hp[socket.id] = room.state.hp[socket.id] ?? 100;
      room.state.ready[socket.id] = false;
      socket.join(roomId);
      socket.data.roomId = roomId;
    }
    const me = socket.id;
    const opp = opponentOf(room, me) || null;
    cb && cb({
      success: true,
      you: { id: me, nickname: room.nick[me] },
      opponent: opp ? { id: opp, nickname: room.nick[opp] } : null,
      state: {
        pos: room.state.pos,
        hp: room.state.hp,
        score: room.state.score,
        ready: room.state.ready
      }
    });

    if (room.players.length === 2) {
      broadcastRoom(roomId, "roomReady", {
        players: room.players.map((id) => ({ id, nickname: room.nick[id] }))
      });
    }
  });

  socket.on("setReady", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    room.state.ready[socket.id] = true;

    // If both ready -> countdown, then start round
    const p = room.players;
    if (p.length === 2 && room.state.ready[p[0]] && room.state.ready[p[1]]) {
      broadcastRoom(roomId, "roundCountdown", { seconds: 3 });
      setTimeout(() => {
        // reset state for round start
        p.forEach((id) => {
          room.state.hp[id] = 100;
          room.state.pos[id] = randomSpawn();
          room.state.next[id] = null;
        });
        broadcastRoom(roomId, "roundStart", {
          pos: room.state.pos,
          hp: room.state.hp
        });
      }, 3000);
    } else {
      // echo readiness to the other player
      socket.to(roomId).emit("opponentReady");
    }
  });

  // ===== MOVEMENT (with anticipation) =====
  socket.on("moveStart", ({ x, y }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    room.state.next[socket.id] = { x, y };
    socket.to(roomId).emit("opponentMoveStart", { x, y });
  });

  socket.on("moveComplete", ({ x, y }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    room.state.pos[socket.id] = { x, y };
    room.state.next[socket.id] = null;
    socket.to(roomId).emit("opponentMoveComplete", { x, y });
  });

  // ===== SPELLS =====
  // type: 'sd' | 'uh'; targetX, targetY are grid coords
  socket.on("castRune", ({ type, targetX, targetY }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    const me = socket.id;
    const opp = opponentOf(room, me);
    let hit = false;
    let hitTarget = null;

    // Self-hit allowed: if target == my current cell
    const myPos = room.state.pos[me];
    if (myPos && myPos.x === targetX && myPos.y === targetY) {
      hit = true;
      hitTarget = me;
    }

    // Opponent hit: exact current or anticipated next cell
    if (opp) {
      const oppPos = room.state.pos[opp];
      const oppNext = room.state.next[opp];
      const hitsOpp =
        (oppPos && oppPos.x === targetX && oppPos.y === targetY) ||
        (oppNext && oppNext.x === targetX && oppNext.y === targetY);
      if (hitsOpp) {
        hit = true;
        hitTarget = opp;
      }
    }

    // Apply effects
    if (hit && hitTarget) {
      if (type === "sd") {
        room.state.hp[hitTarget] = Math.max(0, (room.state.hp[hitTarget] ?? 100) - 40);
      } else if (type === "uh") {
        room.state.hp[hitTarget] = Math.min(100, (room.state.hp[hitTarget] ?? 100) + 40);
      }
    }

    // Notify both clients about the resolved spell (hit or miss)
    broadcastRoom(roomId, "spellResolved", {
      casterId: me,
      type,
      targetX,
      targetY,
      hit,
      hitTargetId: hit ? hitTarget : null,
      hp: room.state.hp
    });

    // Round over?
    const p = room.players;
    if (p.length === 2 && (room.state.hp[p[0]] <= 0 || room.state.hp[p[1]] <= 0)) {
      const winner = room.state.hp[p[0]] <= 0 ? p[1] : p[0];
      room.state.score[winner] = (room.state.score[winner] ?? 0) + 1;
      broadcastRoom(roomId, "roundOver", {
        winnerId: winner,
        score: room.state.score
      });
      // Reset ready; clients will press Ready for next round
      room.state.ready[p[0]] = false;
      room.state.ready[p[1]] = false;
    }
  });

  // ===== DISCONNECT =====
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter((id) => id !== socket.id);
    delete room.nick[socket.id];
    delete room.state.score[socket.id];
    delete room.state.pos[socket.id];
    delete room.state.next[socket.id];
    delete room.state.hp[socket.id];
    delete room.state.ready[socket.id];

    socket.to(roomId).emit("opponentLeft");

    // If empty, nuke room (so its ID becomes available again)
    if (room.players.length === 0) {
      delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));
