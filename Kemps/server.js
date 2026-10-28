// Kemps — online multiplayer server.
// Zero dependencies: plain Node http, Server-Sent Events for pushes, JSON POSTs for actions.
// Run: node server.js   (PORT env var optional, default 3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const EMOTES = ['👍', '😉', '🤔', '😮', '👋', '🙄', '😎', '🤫', '👀', '😂', '🥱', '✌️'];
const REVEAL_MS = 4000;
const EMOTE_COOLDOWN_MS = 700;
const ROOM_IDLE_MS = 1000 * 60 * 60 * 3;
const BOT_NAMES = ['Ada', 'Bruno', 'Cleo', 'Dex', 'Elsa', 'Finn'];

const rooms = new Map(); // code -> room

// ---------- helpers ----------

const id = (n = 16) => crypto.randomBytes(n).toString('hex');

function roomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push({ id: r + s, rank: r, suit: s });
  return shuffle(deck);
}

const teamCount = (room) => room.size / 2;
const teamOf = (room, seat) => seat % teamCount(room);
const partnerOf = (room, seat) => (seat + room.size / 2) % room.size;

function isKemps(hand) {
  return hand.length === 4 && hand.every((c) => c.rank === hand[0].rank);
}

function draw(room) {
  if (room.deck.length === 0) {
    room.deck = shuffle(room.discard);
    room.discard = [];
  }
  return room.deck.pop();
}

function log(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 40) room.log.shift();
}

function playerAt(room, seat) {
  const pid = room.seats[seat];
  return pid ? room.players.get(pid) : null;
}

function nameAt(room, seat) {
  const p = playerAt(room, seat);
  return p ? p.name : `Seat ${seat + 1}`;
}

// ---------- game flow ----------

function dealRound(room) {
  room.deck = newDeck();
  room.discard = [];
  room.hands = Array.from({ length: room.size }, () => []);
  for (let i = 0; i < 4; i++) for (let s = 0; s < room.size; s++) room.hands[s].push(draw(room));
  room.center = Array.from({ length: 4 }, () => draw(room));
  room.refreshVotes = new Set();
  room.phase = 'playing';
  room.result = null;
  room.round += 1;
  for (const b of bots(room)) { b.stuckSince = 0; b.signalledAt = 0; b.nextAct = Date.now() + rand(1500, 3000); }
}

function startGame(room) {
  room.scores = Array(teamCount(room)).fill(0);
  for (let t = 0; t < teamCount(room); t++) {
    if (!room.signals[t]) room.signals[t] = EMOTES[crypto.randomInt(EMOTES.length)];
  }
  room.round = 0;
  room.winner = null;
  room.knownSignals = Array.from({ length: teamCount(room) }, () => new Set());
  room.lastEmote = [];
  log(room, 'Game started. First team to ' + room.target + ' wins!');
  dealRound(room);
}

// A call resolves the round: show everyone's hands briefly, then deal again (or end the game).
function resolveCall(room, result) {
  room.phase = 'reveal';
  room.result = result;
  room.scores[result.scoringTeam] += result.points;
  log(room, result.message);
  // Bots learn: whatever the caught/winning player emoted just before was probably their team's signal.
  if (result.correct) {
    const last = room.lastEmote[result.target];
    if (last && Date.now() - last.t < 20000) room.knownSignals[teamOf(room, result.target)].add(last.emote);
  }
  broadcast(room);

  clearTimeout(room.revealTimer);
  room.revealTimer = setTimeout(() => {
    const winner = room.scores.findIndex((s) => s >= room.target);
    if (winner >= 0) {
      room.phase = 'over';
      room.winner = winner;
      log(room, `Team ${winner + 1} wins the game!`);
    } else {
      dealRound(room);
    }
    broadcast(room);
  }, REVEAL_MS);
}

// ---------- per-player view ----------

function view(room, player) {
  const seat = player.seat;
  const myTeam = seat == null ? null : teamOf(room, seat);
  const showAll = room.phase === 'reveal' || room.phase === 'over';
  return {
    code: room.code,
    you: { id: player.id, name: player.name, seat, team: myTeam, isHost: room.hostId === player.id },
    phase: room.phase,
    size: room.size,
    target: room.target,
    emotes: EMOTES,
    seats: room.seats.map((pid, s) => {
      const p = pid ? room.players.get(pid) : null;
      return {
        seat: s,
        team: teamOf(room, s),
        name: p ? p.name : null,
        connected: p ? p.connected : false,
        isHost: p ? room.hostId === p.id : false,
        isBot: p ? !!p.bot : false,
        cardCount: room.hands ? room.hands[s].length : 0,
        hand: room.hands && (showAll || s === seat) ? room.hands[s] : null,
        votedRefresh: room.refreshVotes ? room.refreshVotes.has(s) : false,
      };
    }),
    spectators: [...room.players.values()].filter((p) => p.seat == null).map((p) => p.name),
    // Only your own team's secret signal is ever sent to you.
    mySignal: myTeam == null ? null : room.signals[myTeam] || null,
    center: room.center,
    deckCount: room.deck.length,
    scores: room.scores,
    result: room.result,
    winner: room.winner,
    log: room.log.slice(-12),
  };
}

// ---------- SSE ----------

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    for (const res of p.streams) send(res, 'state', view(room, p));
  }
}

function broadcastEvent(room, event, data) {
  for (const p of room.players.values()) for (const res of p.streams) send(res, event, data);
}

function sendEmote(room, seat, emote) {
  room.lastEmote[seat] = { emote, t: Date.now() };
  broadcastEvent(room, 'emote', { seat, emote, key: id(4) });
  botsHearEmote(room, seat, emote);
}

// ---------- bots ----------

const rand = (min, max) => min + Math.random() * (max - min);
const bots = (room) => [...room.players.values()].filter((p) => p.bot && p.seat != null);

// Higher is closer to four of a kind: sum of squared rank counts.
function handScore(hand) {
  const counts = {};
  for (const c of hand) counts[c.rank] = (counts[c.rank] || 0) + 1;
  return Object.values(counts).reduce((s, n) => s + n * n, 0);
}

// Run a bot action later, but only if the same round is still being played.
function botLater(room, ms, fn) {
  const round = room.round;
  setTimeout(() => {
    if (room.phase !== 'playing' || room.round !== round) return;
    try { fn(); } catch (err) { if (!(err instanceof GameError)) console.error(err); }
  }, ms);
}

function botAct(room, b) {
  const now = Date.now();
  const team = teamOf(room, b.seat);
  const hand = room.hands[b.seat];

  if (isKemps(hand)) {
    // Signal the partner, and repeat now and then in case they missed it.
    if (!b.signalledAt || now - b.signalledAt > 7000) {
      b.signalledAt = now;
      sendEmote(room, b.seat, room.signals[team]);
    }
    return;
  }
  b.signalledAt = 0;

  // Throw in the odd bluff emote, never our real signal.
  if (Math.random() < 0.05) {
    const fakes = EMOTES.filter((e) => e !== room.signals[team]);
    sendEmote(room, b.seat, fakes[crypto.randomInt(fakes.length)]);
  }

  // Like a person, a bot often just doesn't spot the useful card in time.
  if (Math.random() < 0.35) return;

  let best = null;
  const current = handScore(hand);
  for (let hi = 0; hi < hand.length; hi++) {
    for (let ci = 0; ci < room.center.length; ci++) {
      const trial = hand.slice();
      trial[hi] = room.center[ci];
      const score = handScore(trial);
      if (score > current && (!best || score > best.score)) best = { score, hi, ci };
    }
  }

  if (best) {
    b.stuckSince = 0;
    actions.swap(room, b, { handCard: hand[best.hi].id, centerCard: room.center[best.ci].id });
    broadcast(room);
  } else {
    b.stuckSince = b.stuckSince || now;
    if (now - b.stuckSince > 6000 && !room.refreshVotes.has(b.seat)) {
      actions.voteRefresh(room, b);
      broadcast(room);
    }
  }
}

function botsHearEmote(room, seat, emote) {
  if (room.phase !== 'playing') return;
  const senderTeam = teamOf(room, seat);
  for (const b of bots(room)) {
    if (b.seat === seat) continue;
    const team = teamOf(room, b.seat);
    if (seat === partnerOf(room, b.seat) && emote === room.signals[team]) {
      // Sometimes misses the signal; the partner will send it again.
      if (Math.random() < 0.25) continue;
      botLater(room, rand(1500, 3500), () => actions.kemps(room, b));
    } else if (senderTeam !== team) {
      const known = room.knownSignals[senderTeam].has(emote);
      if (Math.random() < (known ? 0.6 : 0.03)) {
        botLater(room, rand(900, 2500), () => actions.counter(room, b, { seat }));
      }
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'playing') continue;
    for (const b of bots(room)) {
      if (now < (b.nextAct || 0)) continue;
      b.nextAct = now + rand(2000, 4000);
      try { botAct(room, b); } catch (err) { if (!(err instanceof GameError)) console.error(err); }
    }
  }
}, 250);

// ---------- actions ----------

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

const actions = {
  takeSeat(room, p, { seat }) {
    if (room.phase !== 'lobby') fail('The game has already started.');
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.size) fail('No such seat.');
    if (room.seats[seat] && room.seats[seat] !== p.id) fail('That seat is taken.');
    if (p.seat != null) room.seats[p.seat] = null;
    room.seats[seat] = p.id;
    p.seat = seat;
  },

  addBot(room, p, { seat }) {
    if (room.hostId !== p.id) fail('Only the host can add bots.');
    if (room.phase !== 'lobby') fail('The game has already started.');
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.size) fail('No such seat.');
    if (room.seats[seat]) fail('That seat is taken.');
    const used = [...room.players.values()].filter((pl) => pl.bot).map((pl) => pl.baseName);
    const baseName = BOT_NAMES.find((n) => !used.includes(n)) || 'Bot';
    const bot = { id: id(8), token: null, bot: true, baseName, name: baseName + ' 🤖', seat, connected: true, streams: new Set() };
    room.players.set(bot.id, bot);
    room.seats[seat] = bot.id;
  },

  removeBot(room, p, { seat }) {
    if (room.hostId !== p.id) fail('Only the host can remove bots.');
    if (room.phase !== 'lobby') fail('The game has already started.');
    const bot = playerAt(room, seat);
    if (!bot || !bot.bot) fail('No bot in that seat.');
    room.players.delete(bot.id);
    room.seats[seat] = null;
  },

  leaveSeat(room, p) {
    if (room.phase !== 'lobby') fail('The game has already started.');
    if (p.seat != null) room.seats[p.seat] = null;
    p.seat = null;
  },

  setSignal(room, p, { emote }) {
    if (room.phase !== 'lobby') fail('Signals are locked once the game starts.');
    if (p.seat == null) fail('Take a seat first.');
    if (!EMOTES.includes(emote)) fail('Unknown signal.');
    room.signals[teamOf(room, p.seat)] = emote;
  },

  settings(room, p, { size, target }) {
    if (room.hostId !== p.id) fail('Only the host can change settings.');
    if (room.phase !== 'lobby') fail('The game has already started.');
    if (size != null) {
      if (size !== 4 && size !== 6) fail('Play with 4 or 6 players.');
      if (size !== room.size) {
        // Re-seat everyone as spectators when the table changes shape.
        for (const pl of room.players.values()) {
          if (pl.bot) room.players.delete(pl.id);
          else pl.seat = null;
        }
        room.size = size;
        room.seats = Array(size).fill(null);
        room.signals = Array(size / 2).fill(null);
      }
    }
    if (target != null) {
      if (!Number.isInteger(target) || target < 1 || target > 50) fail('Target must be 1–50.');
      room.target = target;
    }
  },

  start(room, p) {
    if (room.hostId !== p.id) fail('Only the host can start.');
    if (room.phase !== 'lobby' && room.phase !== 'over') fail('Already playing.');
    if (room.seats.some((s) => !s)) fail(`All ${room.size} seats must be filled.`);
    startGame(room);
  },

  backToLobby(room, p) {
    if (room.hostId !== p.id) fail('Only the host can do that.');
    if (room.phase !== 'over') fail('Finish the game first.');
    room.phase = 'lobby';
    room.hands = null;
    room.center = [];
    room.deck = [];
  },

  swap(room, p, { handCard, centerCard }) {
    if (room.phase !== 'playing') fail('Not now.');
    if (p.seat == null) fail('Spectators cannot play.');
    const hand = room.hands[p.seat];
    const hi = hand.findIndex((c) => c.id === handCard);
    const ci = room.center.findIndex((c) => c.id === centerCard);
    if (hi < 0) fail('That card is not in your hand.');
    if (ci < 0) fail('Too slow — someone grabbed it!');
    [hand[hi], room.center[ci]] = [room.center[ci], hand[hi]];
    // Any change to the middle cancels a pending refresh vote.
    room.refreshVotes.clear();
  },

  voteRefresh(room, p) {
    if (room.phase !== 'playing') fail('Not now.');
    if (p.seat == null) fail('Spectators cannot vote.');
    if (room.refreshVotes.has(p.seat)) room.refreshVotes.delete(p.seat);
    else room.refreshVotes.add(p.seat);
    if (room.refreshVotes.size === room.size) {
      room.discard.push(...room.center);
      room.center = Array.from({ length: 4 }, () => draw(room));
      room.refreshVotes.clear();
      log(room, 'Everyone agreed — the middle was refreshed.');
    }
  },

  emote(room, p, { emote }) {
    if (p.seat == null) fail('Spectators cannot signal.');
    if (!EMOTES.includes(emote)) fail('Unknown emote.');
    const now = Date.now();
    if (now - (p.lastEmote || 0) < EMOTE_COOLDOWN_MS) return { silent: true };
    p.lastEmote = now;
    sendEmote(room, p.seat, emote);
    return { silent: true };
  },

  kemps(room, p) {
    if (room.phase !== 'playing') fail('Not now.');
    if (p.seat == null) fail('Spectators cannot call.');
    const team = teamOf(room, p.seat);
    const partner = partnerOf(room, p.seat);
    const ok = isKemps(room.hands[partner]);
    if (ok) {
      resolveCall(room, {
        type: 'kemps', correct: true, caller: p.seat, target: partner, scoringTeam: team, points: 1,
        message: `${p.name} called KEMPS — correct! ${nameAt(room, partner)} had four ${room.hands[partner][0].rank}s. Team ${team + 1} +1`,
      });
    } else {
      // A wrong call gives the point away: to the other team, or with 3 teams to the next team round the table.
      const st = (team + 1) % teamCount(room);
      resolveCall(room, {
        type: 'kemps', correct: false, caller: p.seat, target: partner, scoringTeam: st, points: 1,
        message: `${p.name} called KEMPS — wrong! ${nameAt(room, partner)} didn't have it. Team ${st + 1} +1`,
      });
    }
  },

  counter(room, p, { seat }) {
    if (room.phase !== 'playing') fail('Not now.');
    if (p.seat == null) fail('Spectators cannot call.');
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.size) fail('No such seat.');
    const team = teamOf(room, p.seat);
    const accusedTeam = teamOf(room, seat);
    if (accusedTeam === team) fail('You can only counter an opponent.');
    const ok = isKemps(room.hands[seat]);
    resolveCall(room, {
      type: 'counter', correct: ok, caller: p.seat, target: seat,
      scoringTeam: ok ? team : accusedTeam, points: 1,
      message: ok
        ? `${p.name} called COUNTER-KEMPS on ${nameAt(room, seat)} — caught them! Team ${team + 1} +1`
        : `${p.name} called COUNTER-KEMPS on ${nameAt(room, seat)} — wrong! Team ${accusedTeam + 1} +1`,
    });
  },
};

// ---------- HTTP ----------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) reject(new GameError('Request too large.'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new GameError('Bad JSON.')); }
    });
  });
}

function cleanName(name) {
  const n = String(name || '').replace(/[<>]/g, '').trim().slice(0, 16);
  if (!n) fail('Please enter a name.');
  return n;
}

function addPlayer(room, name) {
  const p = { id: id(8), token: id(), name: cleanName(name), seat: null, connected: false, streams: new Set() };
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

function findByToken(room, token) {
  if (!token) return null; // bots have no token
  for (const p of room.players.values()) if (p.token === token) return p;
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app so /ABCD style links work.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const { name } = await readBody(req);
      const room = {
        code: roomCode(), hostId: null, size: 4, target: 10, players: new Map(),
        seats: Array(4).fill(null), signals: Array(2).fill(null), phase: 'lobby',
        deck: [], discard: [], hands: null, center: [], scores: [0, 0], refreshVotes: new Set(),
        log: [], round: 0, result: null, winner: null, lastActive: Date.now(),
        lastEmote: [], knownSignals: [],
      };
      const p = addPlayer(room, name);
      rooms.set(room.code, room);
      return json(res, 200, { code: room.code, token: p.token });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const { code, name } = await readBody(req);
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) fail('No game with that code.');
      const p = addPlayer(room, name);
      broadcast(room);
      return json(res, 200, { code: room.code, token: p.token });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get(url.searchParams.get('code'));
      const p = room && findByToken(room, url.searchParams.get('token'));
      if (!p) return json(res, 404, { error: 'Game not found or expired.' });
      // X-Accel-Buffering stops hosting proxies from holding back live updates.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      p.streams.add(res);
      p.connected = true;
      broadcast(room);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        p.streams.delete(res);
        p.connected = p.streams.size > 0;
        broadcast(room);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/check') {
      const room = rooms.get(url.searchParams.get('code'));
      const p = room && findByToken(room, url.searchParams.get('token'));
      return json(res, p ? 200 : 404, { ok: !!p });
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readBody(req);
      const room = rooms.get(body.code);
      const p = room && findByToken(room, body.token);
      if (!p) fail('Game not found or expired.');
      const fn = actions[body.action];
      if (!fn) fail('Unknown action.');
      const out = fn(room, p, body) || {};
      if (!out.silent) broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof GameError) return json(res, 400, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Server error' });
  }
});

// Drop rooms nobody has touched in a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.lastActive > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 60_000);

server.listen(PORT, () => console.log(`Kemps running on http://localhost:${PORT}`));
