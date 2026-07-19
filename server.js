/* =====================================================================
   ORB SURVIVOR BACKEND
   - Discord OAuth2 code exchange (keeps client secret private)
   - PlayFab bridge (login player by Discord ID, set display name = Discord username)
   - WebSocket relay for realtime multiplayer (authoritative-ish position relay)

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
  res.json({ ok: true, service: 'orb-survivor-server', time: Date.now() });
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

// Logs a Discord user into PlayFab, creating the account on first login.
// Uses the Discord ID as the PlayFab "ServerCustomId" so it's a stable,
// permanent link between the two systems.
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
   Your game redirects the browser to Discord's authorize URL, Discord
   redirects back here with ?code=..., and this exchanges that code for
   the user's identity, then bridges them into PlayFab.
===================================================================== */
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    // 1. Exchange the code for a Discord access token (secret stays server-side)
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

    // 2. Fetch the Discord profile
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

    // 3. Log into (or create) the matching PlayFab account
    const pfLogin = await loginToPlayFabWithDiscordId(discordId);
    const playFabId = pfLogin.PlayFabId;
    const sessionTicket = pfLogin.SessionTicket; // used by the game client for direct Client API calls

    // 4. Make their PlayFab display name their Discord name, and store profile info
    await setPlayFabDisplayName(playFabId, discordUsername).catch(e => console.warn('display name set failed', e.message));
    await setPlayFabUserData(playFabId, {
      discordId,
      discordUsername,
      avatarUrl: avatarUrl || '',
      isOwner: ownerIds.has(discordId) ? 'true' : 'false'
    });

    // 5. Hand the result back to the game. We redirect to the game page with
    //    the session info in the URL fragment (#...) so it never hits server logs.
    //    Change GAME_URL to your actual itch.io page.
    const GAME_URL = ALLOWED_ORIGIN !== '*' ? ALLOWED_ORIGIN : 'https://realz3n0.itch.io/orb';
    const payload = encodeURIComponent(JSON.stringify({
      playFabId,
      sessionTicket,
      discordId,
      discordUsername,
      avatarUrl,
      isOwner: ownerIds.has(discordId)
    }));
    res.redirect(`${GAME_URL}#auth=${payload}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Login failed: ' + err.message);
  }
});

/* =====================================================================
   WEBSOCKET RELAY (the "no lag" multiplayer part)
   - Rooms of players
   - Clients send inputs/positions, server rebroadcasts to everyone else
     in the room at a fixed tick rate
   - Basic sanity limits so one player can't spam garbage data
===================================================================== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map(); // roomId -> { players: Map(ws -> playerState) }
const TICK_MS = 50; // 20 ticks/sec broadcast rate

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { players: new Map() };
    rooms.set(roomId, room);
  }
  return room;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.playerId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      ws.roomId = msg.roomId || 'main';
      ws.playerId = msg.playerId || ('guest_' + Math.random().toString(36).slice(2, 8));
      ws.displayName = msg.displayName || 'Player';
      ws.isOwner = !!msg.isOwner;

      const room = getRoom(ws.roomId);
      room.players.set(ws, {
        id: ws.playerId, name: ws.displayName, x: 0, y: 0, hp: 100, alive: true
      });

      ws.send(JSON.stringify({ type: 'joined', playerId: ws.playerId }));
      return;
    }

    if (msg.type === 'input' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const p = room.players.get(ws);
      if (!p) return;
      // Basic sanity clamp - never fully trust the client's own claimed position.
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        p.x = Math.max(0, Math.min(6400, msg.x));
        p.y = Math.max(0, Math.min(6400, msg.y));
      }
      if (typeof msg.hp === 'number') p.hp = msg.hp;
      if (typeof msg.aimAngle === 'number') p.aimAngle = msg.aimAngle;
      return;
    }

    if (msg.type === 'ownerCommand' && ws.isOwner) {
      // Owner panel commands get relayed to the room; the game client applies
      // the effect locally (set speed / damage / kick / etc). Server just
      // gatekeeps who is allowed to issue them.
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const packet = JSON.stringify({ type: 'ownerCommand', command: msg.command, value: msg.value, target: msg.target });
      for (const client of room.players.keys()) {
        if (client.readyState === WebSocket.OPEN) client.send(packet);
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        room.players.delete(ws);
        if (room.players.size === 0) rooms.delete(ws.roomId);
      }
    }
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

// Broadcast loop: send each room's player snapshot to everyone in it
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.players.size === 0) continue;
    const snapshot = Array.from(room.players.values());
    const packet = JSON.stringify({ type: 'snapshot', players: snapshot });
    for (const client of room.players.keys()) {
      if (client.readyState === WebSocket.OPEN) client.send(packet);
    }
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`Orb Survivor server listening on ${PORT}`));
