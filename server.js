/* =====================================================================
   ORB SURVIVOR BACKEND
   - Discord OAuth2 code exchange (keeps client secret private)
   - PlayFab bridge (login player by Discord ID, set display name = Discord username)
   - WebSocket relay for realtime multiplayer / Team Up co-op (BETA)

   TEAM UP ARCHITECTURE (host-authoritative, low-lag):
   - The first player in a room is the "host". The host's browser runs the
     real simulation (waves, enemy AI, spawns). Everyone else is a
     "follower" - they send inputs and locally-predicted shots, but the
     host's enemy/wave state is the source of truth.
   - This means the server itself does almost no simulation work - it's a
     thin, fast relay - which is what keeps this smooth even on a small
     free-tier instance. Server responsibilities are limited to:
       1. Room membership + ready/start handshake (the lobby flow)
       2. Rebroadcasting player inputs at a fast, fixed tick rate
       3. Rebroadcasting the host's authoritative snapshot (enemies, wave,
          bullets-hit-events) to followers
       4. Rebroadcasting followers' locally-fired shots so everyone sees
          everyone's bullets
       5. Relaying respawn requests/grants and reassigning host on drop

   ALL SECRETS COME FROM ENVIRONMENT VARIABLES. Never hardcode them here.
   Set these in Render's dashboard under your service -> Environment:
     DISCORD_CLIENT_ID       (public, safe to also put in the game client)
     DISCORD_CLIENT_SECRET   (private - rotate if it was ever pasted anywhere public)
     DISCORD_REDIRECT_URI    (e.g. https://your-render-app.onrender.com/auth/discord/callback)
     PLAYFAB_TITLE_ID        (public, e.g. 113584)
     PLAYFAB_SECRET_KEY      (private - rotate if it was ever pasted anywhere public)
     OWNER_DISCORD_IDS       (comma separated list of Discord user IDs who get owner panel access)
     ALLOWED_ORIGIN          (e.g. https://realz3n0.itch.io)
===================================================================== */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const WebSocket = require('ws');

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  PLAYFAB_TITLE_ID,
  PLAYFAB_SECRET_KEY,
  OWNER_DISCORD_IDS = '',
  ALLOWED_ORIGIN = '*',
  PORT = 3000
} = process.env;

const ownerIds = new Set(OWNER_DISCORD_IDS.split(',').map(s => s.trim()).filter(Boolean));

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

/* =====================================================================
   HEALTH CHECK (Render pings this / you can check it's alive in a browser)
===================================================================== */
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'orb-survivor-server', time: Date.now(), rooms: rooms ? rooms.size : 0 });
});

/* =====================================================================
   PLAYFAB HELPERS (all server-side, using the secret key)
===================================================================== */
const PF_BASE = `https://${PLAYFAB_TITLE_ID}.playfabapi.com`;

async function pfCall(path, body, useSecretKey = true) {
  const res = await fetch(`${PF_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(useSecretKey ? { 'X-SecretKey': PLAYFAB_SECRET_KEY } : {})
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.errorMessage || 'PlayFab error');
    err.details = json;
    throw err;
  }
  return json.data;
}

async function loginToPlayFabWithDiscordId(discordId) {
  return pfCall('/Server/LoginWithServerCustomId', {
    ServerCustomId: discordId,
    CreateAccount: true
  });
}

async function setPlayFabDisplayName(playFabId, displayName) {
  return pfCall('/Admin/UpdateUserTitleDisplayName', {
    PlayFabId: playFabId,
    DisplayName: displayName
  });
}

async function setPlayFabUserData(playFabId, data) {
  return pfCall('/Server/UpdateUserData', {
    PlayFabId: playFabId,
    Data: data
  });
}

async function getPlayFabUserData(playFabId) {
  return pfCall('/Server/GetUserData', { PlayFabId: playFabId });
}

/* =====================================================================
   DISCORD OAUTH2 CALLBACK
===================================================================== */
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenJson.error_description || 'Discord token exchange failed');

    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });
    const profile = await profileRes.json();
    if (!profileRes.ok) throw new Error('Failed to fetch Discord profile');

    const discordId = profile.id;
    const discordUsername = profile.global_name || profile.username;
    const avatarUrl = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${discordId}/${profile.avatar}.png`
      : null;

    const pfLogin = await loginToPlayFabWithDiscordId(discordId);
    const playFabId = pfLogin.PlayFabId;
    const sessionTicket = pfLogin.SessionTicket;

    await setPlayFabDisplayName(playFabId, discordUsername).catch(e => console.warn('display name set failed', e.message));
    await setPlayFabUserData(playFabId, {
      discordId,
      discordUsername,
      avatarUrl: avatarUrl || '',
      isOwner: ownerIds.has(discordId) ? 'true' : 'false'
    });

    const payload = JSON.stringify({
      playFabId,
      sessionTicket,
      discordId,
      discordUsername,
      avatarUrl,
      isOwner: ownerIds.has(discordId)
    });
    res.send(`<!DOCTYPE html><html><body style="background:#05060a;color:#e9edf7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
      <p>Login complete — you can close this window.</p>
      <script>
        try {
          if (window.opener) {
            window.opener.postMessage({ type: 'orbsurvivor_auth', payload: ${payload} }, '*');
          }
        } catch (e) {}
        setTimeout(() => window.close(), 800);
      </script>
    </body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Login failed: ' + err.message);
  }
});

/* =====================================================================
   WEBSOCKET RELAY - TEAM UP (BETA)
===================================================================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false }); // compression adds latency for tiny frequent packets - skip it

const rooms = new Map(); // roomId -> Room
const INPUT_TICK_MS = 33;   // ~30Hz position/aim relay (was 20Hz) - noticeably smoother
const HOST_SYNC_TICK_MS = 50; // ~20Hz host authoritative snapshot relay (enemies/wave)
const MAX_ROOM_SIZE = 8;

function makeRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),   // ws -> playerState
    hostWs: null,
    started: false,
    wave: 1,
  };
}
function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }
  return room;
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcastRoom(room, obj, exceptWs) {
  const packet = JSON.stringify(obj);
  for (const client of room.players.keys()) {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) client.send(packet);
  }
}

function lobbySnapshot(room) {
  return {
    type: 'lobbyState',
    hostId: room.hostWs ? room.players.get(room.hostWs)?.id : null,
    started: room.started,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, ready: !!p.ready, isHost: room.hostWs && room.players.get(room.hostWs)?.id === p.id
    }))
  };
}
function broadcastLobby(room) {
  broadcastRoom(room, lobbySnapshot(room));
}

// Reassign host to the longest-connected remaining player (Map preserves insertion order).
function reassignHostIfNeeded(room) {
  if (room.hostWs && room.players.has(room.hostWs)) return; // still valid
  const next = room.players.keys().next();
  room.hostWs = next.done ? null : next.value;
  if (room.hostWs) {
    // New host never inherits the old host's mid-run sim state - safest is to
    // drop back to the lobby so nobody's stuck watching a frozen game.
    room.started = false;
    for (const p of room.players.values()) p.ready = false;
    broadcastRoom(room, { type: 'hostChanged', hostId: room.players.get(room.hostWs).id });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.playerId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* ---------------- JOIN ---------------- */
    if (msg.type === 'join') {
      ws.roomId = msg.roomId || 'main';
      ws.playerId = msg.playerId || ('guest_' + Math.random().toString(36).slice(2, 8));
      ws.displayName = msg.displayName || 'Player';
      ws.isOwner = ownerIds.has(ws.playerId); // never trust client-claimed isOwner

      const room = getRoom(ws.roomId);
      if (room.players.size >= MAX_ROOM_SIZE) {
        safeSend(ws, { type: 'joinRejected', reason: 'Lobby is full.' });
        ws.close();
        return;
      }

      room.players.set(ws, {
        id: ws.playerId, name: ws.displayName, x: 0, y: 0, hp: 100, alive: true,
        ready: false
      });
      if (!room.hostWs) room.hostWs = ws; // first player in an empty room becomes host

      ws.send(JSON.stringify({
        type: 'joined',
        playerId: ws.playerId,
        isOwner: ws.isOwner,
        isHost: room.hostWs === ws,
        started: room.started
      }));
      broadcastLobby(room);
      return;
    }

    if (!ws.roomId) return; // everything below requires having joined a room
    const room = rooms.get(ws.roomId);
    if (!room) return;

    /* ---------------- READY / START (lobby handshake) ---------------- */
    if (msg.type === 'ready') {
      const p = room.players.get(ws);
      if (p) { p.ready = !!msg.value; broadcastLobby(room); }
      return;
    }

    if (msg.type === 'startGame') {
      if (ws !== room.hostWs) return; // only the host can start
      room.started = true;
      room.wave = 1;
      broadcastRoom(room, { type: 'gameStart', seed: Date.now() });
      return;
    }

    if (msg.type === 'leaveGame') {
      // Host or player voluntarily returns everyone to the lobby (e.g. host ended the run)
      if (ws === room.hostWs) {
        room.started = false;
        for (const p of room.players.values()) p.ready = false;
        broadcastRoom(room, { type: 'gameEnded' });
        broadcastLobby(room);
      }
      return;
    }

    /* ---------------- FAST POSITION/INPUT RELAY ---------------- */
    if (msg.type === 'input') {
      const p = room.players.get(ws);
      if (!p) return;
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        p.x = Math.max(0, Math.min(6400, msg.x));
        p.y = Math.max(0, Math.min(6400, msg.y));
      }
      if (typeof msg.hp === 'number') p.hp = Math.max(0, Math.min(999999, msg.hp));
      if (typeof msg.aimAngle === 'number') p.aimAngle = msg.aimAngle;
      if (typeof msg.alive === 'boolean') p.alive = msg.alive;
      if (typeof msg.weaponId === 'string') p.weaponId = msg.weaponId;
      return;
    }

    /* ---------------- SHARED SHOOTING: followers' own shots ---------------- */
    // A client fired locally (client-side predicted) - broadcast it immediately
    // to everyone else so their bullets appear in real time, not waiting on the
    // slower host-sync tick. Kept intentionally tiny (no per-frame retransmit).
    if (msg.type === 'shotFired') {
      broadcastRoom(room, { type: 'shotFired', from: ws.playerId, bullets: msg.bullets }, ws);
      return;
    }

    // A client's bullet hit something - forward to the host, who is the only
    // one allowed to actually apply damage to the shared enemy list.
    if (msg.type === 'hitReport') {
      if (room.hostWs && room.hostWs !== ws) safeSend(room.hostWs, { type: 'hitReport', from: ws.playerId, hit: msg.hit });
      return;
    }

    /* ---------------- HOST AUTHORITATIVE SNAPSHOT ---------------- */
    // Only the host's browser runs real enemy AI/wave logic; it pushes a
    // compact snapshot down to everyone else at a fixed tick rate.
    if (msg.type === 'hostSync') {
      if (ws !== room.hostWs) return; // ignore spoofed snapshots from non-hosts
      if (typeof msg.wave === 'number') room.wave = msg.wave;
      broadcastRoom(room, { type: 'hostSync', enemies: msg.enemies, wave: msg.wave, waveState: msg.waveState }, ws);
      return;
    }

    /* ---------------- RESPAWN (team-up only: after the wave clears) ---------------- */
    if (msg.type === 'respawnRequest') {
      if (room.hostWs) safeSend(room.hostWs, { type: 'respawnRequest', from: ws.playerId });
      return;
    }
    if (msg.type === 'respawnGranted') {
      if (ws !== room.hostWs) return; // only host decides
      const target = Array.from(room.players.entries()).find(([, p]) => p.id === msg.target);
      if (target) { target[1].hp = msg.hp || 100; target[1].alive = true; safeSend(target[0], { type: 'respawnGranted' }); }
      return;
    }

    /* ---------------- OWNER PANEL COMMANDS ---------------- */
    if (msg.type === 'ownerCommand' && ws.isOwner) {
      const packet = JSON.stringify({ type: 'ownerCommand', command: msg.command, value: msg.value, target: msg.target });
      for (const client of room.players.keys()) {
        if (client.readyState === WebSocket.OPEN) client.send(packet);
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.players.delete(ws);
    if (room.players.size === 0) { rooms.delete(ws.roomId); return; }
    reassignHostIfNeeded(room);
    broadcastLobby(room);
    broadcastRoom(room, { type: 'playerLeft', id: ws.playerId });
  });
});

// Heartbeat: drop dead connections so rooms don't fill with ghosts
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// Fast position/input broadcast loop - snapshot is small (id/x/y/hp/aim per
// player) so a higher tick rate here is cheap and meaningfully reduces the
// "rubber-banding" feel of the old 20Hz relay.
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.players.size < 2) continue; // nobody to sync with yet, skip the work
    const snapshot = Array.from(room.players.values());
    const packet = JSON.stringify({ type: 'snapshot', players: snapshot });
    for (const client of room.players.keys()) {
      if (client.readyState === WebSocket.OPEN) client.send(packet);
    }
  }
}, INPUT_TICK_MS);

server.listen(PORT, () => console.log(`Orb Survivor server listening on ${PORT} (input tick ${INPUT_TICK_MS}ms, host-sync tick ${HOST_SYNC_TICK_MS}ms)`));
