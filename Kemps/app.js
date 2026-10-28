// Kemps — browser client.
const $ = (sel) => document.querySelector(sel);
const TEAM_COLORS = ['var(--team0)', 'var(--team1)', 'var(--team2)'];
const TEAM_NAMES = ['Blue', 'Red', 'Green'];

let session = null; // { code, token }
let state = null;
let source = null;
let selHand = null;
let selCenter = null;
let prevCenter = [];
let seatEls = new Map(); // seat -> { el, body }
let seatLayoutKey = '';

// ---------- networking ----------

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function act(action, extra = {}) {
  try {
    await post('/api/action', { code: session.code, token: session.token, action, ...extra });
  } catch (e) {
    toast(e.message);
  }
}

function connect() {
  if (source) source.close();
  source = new EventSource(`/api/events?code=${session.code}&token=${session.token}`);
  source.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
  source.addEventListener('emote', (e) => showEmote(JSON.parse(e.data)));
  source.onerror = () => {
    // EventSource retries by itself; if the game is gone the server answers 404 and we go home.
    if (!session) return;
    fetch(`/api/check?code=${session.code}&token=${session.token}`).then((r) => {
      if (r.status === 404) leaveToHome('That game has ended or expired.');
    }).catch(() => {});
  };
}

function saveSession() {
  // Per tab, so one browser can hold several players while testing; survives reloads.
  sessionStorage.setItem('kemps-session', JSON.stringify(session));
  history.replaceState(null, '', '/' + session.code);
}

function leaveToHome(msg) {
  if (source) source.close();
  source = null;
  session = null;
  state = null;
  sessionStorage.removeItem('kemps-session');
  history.replaceState(null, '', '/');
  show('home');
  $('#homeError').textContent = msg || '';
}

// ---------- ui helpers ----------

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

function cardEl(card, opts = {}) {
  const red = card.suit === '♥' || card.suit === '♦';
  return el('div', { class: `card ${red ? 'red' : ''} ${opts.tiny ? 'tiny' : ''} ${opts.cls || ''}`, onclick: opts.onclick }, [
    el('span', { class: 'r', textContent: card.rank }),
    el('span', { class: 's', textContent: card.suit }),
    el('span', { class: 'r2', textContent: card.rank }),
  ]);
}

const teamColor = (t) => TEAM_COLORS[t];
const teamName = (t) => `${TEAM_NAMES[t]} team`;

// ---------- rendering ----------

function render() {
  if (!state) return;
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); }
  else { show('game'); renderGame(); }
}

function renderLobby() {
  $('#lobbyCode').textContent = state.code;
  const list = $('#seatList');
  list.innerHTML = '';
  // List seats so partners line up: Blue pair, Red pair, (Green pair).
  const order = [];
  const teams = state.size / 2;
  for (let t = 0; t < teams; t++) order.push(t, t + teams);
  for (const s of order) {
    const seat = state.seats[s];
    const mine = s === state.you.seat;
    const host = state.you.isHost;
    let btn = null;
    if (mine) btn = el('button', { textContent: 'Leave', onclick: () => act('leaveSeat') });
    else if (seat.isBot && host) btn = el('button', { textContent: 'Remove bot', onclick: () => act('removeBot', { seat: s }) });
    else if (!seat.name) {
      btn = el('div', { class: 'seat-btns' }, [
        el('button', { textContent: 'Sit here', onclick: () => act('takeSeat', { seat: s }) }),
        host ? el('button', { textContent: '+ Bot', title: 'Fill this seat with a computer player', onclick: () => act('addBot', { seat: s }) }) : null,
      ]);
    }
    list.append(el('div', { class: 'seat-slot', style: `--tc:${teamColor(seat.team)}` }, [
      el('div', {}, [
        el('div', { class: 'label', textContent: `${teamName(seat.team)} · seat ${s + 1}` }),
        el('div', { class: 'who', textContent: seat.name ? seat.name + (seat.isHost ? ' ★' : '') + (mine ? ' (you)' : '') : 'Empty' }),
      ]),
      btn,
    ]));
  }

  const seated = state.you.seat != null;
  $('#signalBox').classList.toggle('hidden', !seated);
  if (seated) {
    const picker = $('#signalPicker');
    picker.innerHTML = '';
    for (const e of state.emotes) {
      picker.append(el('button', { textContent: e, class: e === state.mySignal ? 'selected' : '', onclick: () => act('setSignal', { emote: e }) }));
    }
  }

  const host = state.you.isHost;
  $('#hostBox').classList.toggle('hidden', !host);
  $('#waitHost').classList.toggle('hidden', host);
  if (host) {
    $('#sizeSel').value = String(state.size);
    if (document.activeElement !== $('#targetInput')) $('#targetInput').value = state.target;
    const full = state.seats.every((s) => s.name);
    $('#startBtn').disabled = !full;
    $('#startBtn').textContent = full ? 'Start game' : `Waiting for players (${state.seats.filter((s) => s.name).length}/${state.size})`;
  }
  $('#spectators').textContent = state.spectators.length ? 'Not seated: ' + state.spectators.join(', ') : '';
}

function seatPosition(offset, size) {
  // Offset 0 is you (bottom). Others go clockwise around an ellipse.
  const angle = (90 + (offset * 360) / size) * (Math.PI / 180);
  return { x: 50 + 44 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) };
}

function ensureSeatEls() {
  const key = `${state.size}:${state.you.seat}`;
  if (key === seatLayoutKey) return;
  seatLayoutKey = key;
  const box = $('#seats');
  box.innerHTML = '';
  seatEls = new Map();
  const mySeat = state.you.seat ?? 0;
  for (let s = 0; s < state.size; s++) {
    const offset = (s - mySeat + state.size) % state.size;
    if (offset === 0 && state.you.seat != null) continue; // your seat is the panel at the bottom
    const pos = seatPosition(offset, state.size);
    const body = el('div');
    const bubbleSlot = el('div');
    const e = el('div', { class: 'seat', style: `left:${pos.x}%;top:${pos.y}%;--tc:${teamColor(s % (state.size / 2))}` }, [body, bubbleSlot]);
    box.append(e);
    seatEls.set(s, { el: e, body, bubbleSlot });
  }
}

function renderGame() {
  const me = state.you;
  const playing = state.phase === 'playing';
  $('#gameCode').textContent = state.code;
  $('#gameTarget').textContent = state.target;

  // scoreboard
  const sb = $('#scoreboard');
  sb.innerHTML = '';
  state.scores.forEach((pts, t) => {
    const names = state.seats.filter((s) => s.team === t).map((s) => s.name).join(' & ');
    sb.append(el('div', { class: `score ${t === me.team ? 'mine' : ''}`, style: `--tc:${teamColor(t)}`, title: names, textContent: `${TEAM_NAMES[t]} ${pts}` }));
  });

  // other seats
  ensureSeatEls();
  for (const [s, { body }] of seatEls) {
    const seat = state.seats[s];
    body.innerHTML = '';
    const isOpponent = me.team != null && seat.team !== me.team;
    const isPartner = me.team != null && seat.team === me.team;
    body.append(el('div', { class: 'nm' }, [el('span', { class: `dot ${seat.connected ? 'on' : ''}` }), seat.name || 'Empty']));
    body.append(el('div', { class: 'sub', textContent: isPartner ? 'Partner' : teamName(seat.team) }));
    const mini = el('div', { class: 'mini-hand' });
    if (seat.hand) seat.hand.forEach((c) => mini.append(cardEl(c, { tiny: true })));
    else for (let i = 0; i < seat.cardCount; i++) mini.append(el('div', { class: 'back' }));
    body.append(mini);
    if (isOpponent && playing) {
      body.append(el('button', { class: 'counter-btn', textContent: 'Counter!', title: `Call Counter-Kemps on ${seat.name}`, onclick: () => act('counter', { seat: s }) }));
    }
    if (seat.votedRefresh) body.append(el('div', { class: 'sub', textContent: '↻ wants refresh' }));
  }

  // center
  const center = $('#center');
  center.innerHTML = '';
  const prevIds = new Set(prevCenter);
  if (!state.center.some((c) => c.id === selCenter)) selCenter = null;
  state.center.forEach((c) => {
    const cls = ['clickable', c.id === selCenter ? 'selected' : '', prevCenter.length && !prevIds.has(c.id) ? 'flash' : ''].join(' ');
    center.append(cardEl(c, { cls, onclick: () => pickCenter(c.id) }));
  });
  prevCenter = state.center.map((c) => c.id);
  $('#deckCount').textContent = `${state.deckCount} in deck`;
  const votes = state.seats.filter((s) => s.votedRefresh).length;
  const myVote = me.seat != null && state.seats[me.seat].votedRefresh;
  const rb = $('#refreshBtn');
  rb.textContent = `↻ Refresh middle (${votes}/${state.size})`;
  rb.classList.toggle('voted', myVote);
  rb.disabled = !playing || me.seat == null;

  // my panel
  const mePanel = $('.me');
  mePanel.style.setProperty('--tc', me.team != null ? teamColor(me.team) : '#333');
  $('#myName').textContent = me.seat != null ? `${me.name} · ${teamName(me.team)}` : `${me.name} (watching)`;
  $('#mySignal').innerHTML = state.mySignal ? `Your team's secret signal: <b>${state.mySignal}</b>` : '';
  const hand = $('#hand');
  hand.innerHTML = '';
  const myHand = me.seat != null ? state.seats[me.seat].hand || [] : [];
  if (!myHand.some((c) => c.id === selHand)) selHand = null;
  myHand.forEach((c, i) => {
    hand.append(cardEl(c, { cls: `clickable ${c.id === selHand ? 'selected' : ''}`, onclick: () => pickHand(c.id) }));
  });

  const bar = $('#emoteBar');
  if (!bar.childElementCount || bar.dataset.signal !== state.mySignal) {
    bar.innerHTML = '';
    bar.dataset.signal = state.mySignal;
    for (const e of state.emotes) {
      bar.append(el('button', { textContent: e, class: e === state.mySignal ? 'mine' : '', title: e === state.mySignal ? 'Your secret signal' : 'Emote (bluff!)', onclick: () => act('emote', { emote: e }) }));
    }
  }
  $('#kempsBtn').disabled = !playing || me.seat == null;
  $('#emoteBar').classList.toggle('hidden', me.seat == null);

  const iHaveKemps = myHand.length === 4 && myHand.every((c) => c.rank === myHand[0].rank);
  $('#hint').textContent = !playing ? '' :
    iHaveKemps ? `You have four ${myHand[0].rank}s! Send your signal ${state.mySignal} so your partner calls KEMPS.` :
    'Click one of your cards, then a card in the middle, to swap them. Keyboard: 1–4 picks a card in your hand, Q W E R picks one in the middle, K calls KEMPS.';

  // result banner
  const banner = $('#banner');
  if (state.phase === 'reveal' && state.result) {
    banner.textContent = state.result.message;
    banner.className = `banner ${state.result.scoringTeam === me.team ? 'good' : 'bad'}`;
  } else banner.className = 'banner hidden';

  // log
  const log = $('#log');
  log.innerHTML = '';
  [...state.log].reverse().forEach((l) => log.append(el('div', { textContent: l.text })));

  // game over
  const over = state.phase === 'over';
  $('#overBox').classList.toggle('hidden', !over);
  if (over) {
    $('#overTitle').textContent = state.winner === me.team ? 'Your team wins! 🎉' : `${teamName(state.winner)} wins!`;
    $('#overScores').innerHTML = '';
    state.scores.forEach((pts, t) => $('#overScores').append(el('div', { style: `color:${teamColor(t)};font-weight:700`, textContent: `${TEAM_NAMES[t]}: ${pts}` })));
    $('#againBtn').classList.toggle('hidden', !me.isHost);
    $('#lobbyBtn').classList.toggle('hidden', !me.isHost);
    $('#overWait').classList.toggle('hidden', me.isHost);
  }
}

// ---------- interactions ----------

function trySwap() {
  if (selHand && selCenter) {
    const handCard = selHand, centerCard = selCenter;
    selHand = selCenter = null;
    act('swap', { handCard, centerCard });
  }
  render();
}

function pickHand(id) {
  if (!state || state.phase !== 'playing') return;
  selHand = selHand === id ? null : id;
  trySwap();
}

function pickCenter(id) {
  if (!state || state.phase !== 'playing' || state.you.seat == null) return;
  selCenter = selCenter === id ? null : id;
  trySwap();
}

function showEmote({ seat, emote, key }) {
  const bubble = el('span', { class: 'bubble', textContent: emote });
  if (state && seat === state.you.seat) {
    const mine = $('#myBubble');
    mine.textContent = emote;
    mine.classList.remove('hidden');
    mine.style.animation = 'none';
    mine.offsetHeight; // restart animation
    mine.style.animation = '';
    clearTimeout(mine._t);
    mine._t = setTimeout(() => mine.classList.add('hidden'), 2200);
    return;
  }
  const slot = seatEls.get(seat);
  if (!slot) return;
  slot.bubbleSlot.innerHTML = '';
  slot.bubbleSlot.append(bubble);
  setTimeout(() => bubble.remove(), 2200);
}

document.addEventListener('keydown', (e) => {
  if (!state || state.phase !== 'playing' || e.target.tagName === 'INPUT') return;
  const me = state.seats[state.you.seat];
  if (!me || !me.hand) return;
  const k = e.key.toLowerCase();
  if ('1234'.includes(k) && me.hand[+k - 1]) pickHand(me.hand[+k - 1].id);
  const ci = 'qwer'.indexOf(k);
  if (ci >= 0 && state.center[ci]) pickCenter(state.center[ci].id);
  if (k === 'k') act('kemps');
});

// ---------- wiring ----------

function getName() {
  const n = $('#name').value.trim();
  localStorage.setItem('kemps-name', n);
  return n;
}

$('#createBtn').onclick = async () => {
  try {
    session = await post('/api/create', { name: getName() });
    saveSession();
    connect();
  } catch (e) { $('#homeError').textContent = e.message; }
};

$('#joinBtn').onclick = async () => {
  try {
    session = await post('/api/join', { code: $('#joinCode').value.trim().toUpperCase(), name: getName() });
    saveSession();
    connect();
  } catch (e) { $('#homeError').textContent = e.message; }
};
$('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });

$('#copyLink').onclick = async () => {
  const link = `${location.origin}/${state.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); }
  catch { prompt('Copy this link:', link); }
};
$('#sizeSel').onchange = (e) => act('settings', { size: +e.target.value });
$('#targetInput').onchange = (e) => act('settings', { target: +e.target.value });
$('#startBtn').onclick = () => act('start');
$('#kempsBtn').onclick = () => act('kemps');
$('#refreshBtn').onclick = () => act('voteRefresh');
$('#againBtn').onclick = () => act('start');
$('#lobbyBtn').onclick = () => act('backToLobby');

// Boot: rejoin a saved game, or prefill a code from the URL (/ABCD).
$('#name').value = localStorage.getItem('kemps-name') || '';
const urlCode = location.pathname.slice(1).toUpperCase();
const saved = JSON.parse(sessionStorage.getItem('kemps-session') || 'null');
if (saved && (!urlCode || urlCode === saved.code)) {
  session = saved;
  connect();
} else if (/^[A-Z]{4}$/.test(urlCode)) {
  $('#joinCode').value = urlCode;
}
