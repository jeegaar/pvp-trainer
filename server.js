// server.js
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

// Rooms: { roomId: { players: {socketId: player}, state: {...}} }
const rooms = {};

function makeEmptyRoom() {
  return {
    players: {}, // socketId -> player object
    playerOrder: [], // socketIds (max 2)
    ready: {}, // socketId -> bool
    match: null // match state
  };
}

function createMatchState() {
  return {
    boardSize: 32,
    maxHP: 100,
    roundWins: {}, // socketId -> wins
    currentRound: 0,
    inRound: false,
    roundStartTime: null
  };
}

// helper: clamp
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

io.on('connection', (socket) => {
  console.log('conn', socket.id);

  socket.on('create_room', () => {
    const roomId = uuidv4().slice(0,8);
    rooms[roomId] = makeEmptyRoom();
    socket.emit('room_created', { roomId, url: `/room/${roomId}` });
  });

  socket.on('join_room', ({roomId, name}) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('join_error', 'Room not found');
      return;
    }
    if (Object.keys(room.players).length >= 2) {
      socket.emit('join_error', 'Room full');
      return;
    }
    // add player
    const player = {
      id: socket.id,
      name: name || 'Player',
      x: Math.floor(Math.random()*32),
      y: Math.floor(Math.random()*32),
      maxHP: 100,
      hp: 100,
      lastMoveTimestamps: [], // timestamps of moves for rate limit (2 per sec)
      lastShootAt: 0,
      ready: false,
      movingUntil: 0 // ms time where movement cooldown ends
    };
    room.players[socket.id] = player;
    room.playerOrder.push(socket.id);
    room.ready[socket.id] = false;

    socket.join(roomId);
    socket.roomId = roomId;

    // initialize match state if missing
    if (!room.match) {
      room.match = createMatchState();
      for (const id of Object.keys(room.players)) room.match.roundWins[id] = 0;
    }

    io.to(roomId).emit('room_update', { players: Object.values(room.players), ready: room.ready });
  });

  socket.on('set_ready', ({ready}) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.ready[socket.id] = !!ready;
    io.to(socket.roomId).emit('room_update', { players: Object.values(room.players), ready: room.ready });

    // if two players and both ready -> start countdown -> start round
    if (Object.keys(room.players).length === 2 && Object.values(room.ready).every(Boolean) && !room.match.inRound) {
      startRoundCountdown(socket.roomId);
    }
  });

  socket.on('move', ({dx, dy}) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    const now = Date.now();
    // rate limit: allow at most 2 moves per 1000ms window
    p.lastMoveTimestamps = p.lastMoveTimestamps.filter(t => now - t <= 1000);
    if (p.lastMoveTimestamps.length >= 2) return; // ignore

    const nx = clamp(p.x + dx, 0, 31);
    const ny = clamp(p.y + dy, 0, 31);
    // set position to destination immediately (to satisfy "target is destination during move")
    p.x = nx; p.y = ny;
    p.lastMoveTimestamps.push(now);
    p.movingUntil = now + 500; // movement animation 500ms, but considered at destination already

    io.to(socket.roomId).emit('player_moved', { id: socket.id, x: p.x, y: p.y });
  });

  socket.on('shoot', ({tx, ty, rune}) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    const now = Date.now();
    if (now - p.lastShootAt < 1000) return; // 1s cooldown
    p.lastShootAt = now;

    // validate target inside grid
    if (tx < 0 || ty < 0 || tx >= 32 || ty >= 32) return;

    // when rune lands, check who is on that tile (server authoritative)
    // immediate effect for simplicity (no projectile travel)
    const victims = Object.values(room.players).filter(pl => pl.x === tx && pl.y === ty);
    for (const v of victims) {
      if (rune === 'SD') {
        const dmg = Math.floor(0.4 * v.maxHP);
        v.hp = Math.max(0, v.hp - dmg);
      } else if (rune === 'UH') {
        // heal caster
        p.hp = Math.min(p.maxHP, p.hp + Math.floor(0.4 * p.maxHP));
      }
    }

    io.to(socket.roomId).emit('rune_fired', { from: socket.id, tx, ty, rune });
    io.to(socket.roomId).emit('hp_update', { players: Object.values(room.players).map(pl => ({id: pl.id, hp: pl.hp})) });

    // check deaths
    for (const v of Object.values(room.players)) {
      if (v.hp <= 0) {
        handleRoundEnd(socket.roomId, socket.id /* shooter id */ , v.id);
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    delete room.players[socket.id];
    room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
    delete room.ready[socket.id];
    io.to(roomId).emit('room_update', { players: Object.values(room.players), ready: room.ready });
    // cleanup empty room
    if (Object.keys(room.players).length === 0) delete rooms[roomId];
  });

  function startRoundCountdown(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.match.inRound = false;
    let count = 3;
    io.to(roomId).emit('countdown', {count});
    const iv = setInterval(() => {
      count--;
      if (count > 0) io.to(roomId).emit('countdown', {count});
      else {
        clearInterval(iv);
        io.to(roomId).emit('countdown', {count: 'GO'});
        startRound(roomId);
      }
    }, 1000);
  }

  function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.match.inRound = true;
    room.match.currentRound++;
    // reset players positions and hp
    for (const id of Object.keys(room.players)) {
      room.players[id].x = Math.floor(Math.random()*32);
      room.players[id].y = Math.floor(Math.random()*32);
      room.players[id].hp = room.players[id].maxHP;
      room.players[id].lastMoveTimestamps = [];
      room.players[id].lastShootAt = 0;
    }
    io.to(roomId).emit('round_started', { players: Object.values(room.players) });
  }

  function handleRoundEnd(roomId, attackerId, victimId) {
    const room = rooms[roomId];
    if (!room) return;
    // give win to attacker (if attacker equals victim? handle suicides -> attackerId=null)
    const winnerId = attackerId === victimId ? null : attackerId;
    if (winnerId) {
      room.match.roundWins[winnerId] = (room.match.roundWins[winnerId] || 0) + 1;
    }
    io.to(roomId).emit('round_ended', { winnerId, roundWins: room.match.roundWins });
    // check match end
    const winners = Object.keys(room.match.roundWins).filter(id => room.match.roundWins[id] >= 2);
    if (winners.length > 0) {
      io.to(roomId).emit('match_ended', { winnerId: winners[0] });
      room.match = createMatchState();
      // keep players in lobby, require ready again
      room.ready = {};
      for (const id of Object.keys(room.players)) room.ready[id] = false;
    } else {
      // start next round after short delay and countdown
      room.match.inRound = false;
      setTimeout(() => startRoundCountdown(roomId), 1500);
    }
  }

});

server.listen(PORT, () => console.log('Listening', PORT));
