// Server logic for the Vosmerka Mini App. Kept free of Cloudflare-only imports so it can be tested in Node.
import './physics.js';
import './rules.js';
import './match.js';

const { Match } = globalThis.PoolMatch;

// ---------- helpers ----------
const enc = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
const randomId = (n = 10) => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map(x => a[x % a.length]).join('');
};

// Telegram initData check. Returns { user, startParam } or null.
export async function verifyInitData(initData, botToken, maxAgeSec = 7 * 24 * 3600) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const secret = await hmac('WebAppData', botToken);
  // Telegram docs: every field except hash. Some clients/libraries leave out "signature"; accept both.
  const variants = [pairs, pairs.filter(p => p[0] !== 'signature')];
  let ok = false;
  for (const v of variants) {
    const dcs = v.map(([k, val]) => `${k}=${val}`).join('\n');
    if (hex(await hmac(secret, dcs)) === hash) { ok = true; break; }
  }
  if (!ok) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
  if (!user || !user.id) return null;
  return { user, startParam: params.get('start_param') || '' };
}

const displayName = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Игрок';

// ---------- D1 ----------
export async function upsertUser(db, u) {
  const now = Date.now();
  await db.prepare(`INSERT INTO users (id, name, username, photo_url, created_at, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(id) DO UPDATE SET name = ?2, username = ?3, photo_url = ?4, last_seen = ?5`)
    .bind(u.id, displayName(u), u.username || null, u.photo_url || null, now).run();
}
export async function getUser(db, id) {
  return db.prepare('SELECT id, name, username, photo_url, games, wins FROM users WHERE id = ?1').bind(id).first();
}
export async function addFriends(db, a, b) {
  if (!a || !b || a === b) return false;
  const exists = await db.prepare('SELECT 1 FROM users WHERE id = ?1').bind(b).first();
  if (!exists) return false;
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO friends (a, b, created_at) VALUES (?1, ?2, ?3)').bind(a, b, now),
    db.prepare('INSERT OR IGNORE INTO friends (a, b, created_at) VALUES (?1, ?2, ?3)').bind(b, a, now),
  ]);
  return true;
}
export async function areFriends(db, a, b) {
  return !!(await db.prepare('SELECT 1 FROM friends WHERE a = ?1 AND b = ?2').bind(a, b).first());
}
export async function friendIds(db, id) {
  const r = await db.prepare('SELECT b FROM friends WHERE a = ?1').bind(id).all();
  return (r.results || []).map(x => x.b);
}
export async function friendsOf(db, id) {
  const r = await db.prepare(`SELECT u.id, u.name, u.username, u.photo_url, u.games, u.wins
      FROM friends f JOIN users u ON u.id = f.b WHERE f.a = ?1 ORDER BY u.name`).bind(id).all();
  return r.results || [];
}

// ---------- bot ----------
export async function botSend(env, chatId, text, buttonText, url) {
  if (!env.BOT_TOKEN) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: buttonText, url }]] } }),
    });
    return r.ok;
  } catch (e) { return false; }
}
export const appLink = (env, param) => `https://t.me/${env.BOT_USERNAME}/${env.APP_NAME}${param ? '?startapp=' + param : ''}`;

// ---------- HTTP entry ----------
export async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/me' || path.startsWith('/ws/')) {
    const initData = request.headers.get('x-init-data') || url.searchParams.get('initData') || '';
    const auth = await verifyInitData(initData, env.BOT_TOKEN);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    const u = auth.user;
    if (path === '/api/me') {
      await upsertUser(env.DB, u);
      let addedFriend = null;
      const sp = auth.startParam;
      if (sp.startsWith('f')) {
        const other = Number(sp.slice(1));
        if (await addFriends(env.DB, u.id, other)) addedFriend = await getUser(env.DB, other);
      }
      const [me, friends] = await Promise.all([getUser(env.DB, u.id), friendsOf(env.DB, u.id)]);
      return json({
        me, friends, addedFriend, startParam: sp,
        bot: env.BOT_USERNAME || '', app: env.APP_NAME || '',
        inviteLink: appLink(env, 'f' + u.id),
      });
    }
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const headers = new Headers(request.headers);
    headers.set('x-user', encodeURIComponent(JSON.stringify({ id: u.id, name: displayName(u), photo: u.photo_url || null })));
    if (path === '/ws/lobby') {
      await upsertUser(env.DB, u);
      const stub = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
      return stub.fetch(new Request(request.url, { headers, method: 'GET' }));
    }
    const m = path.match(/^\/ws\/match\/([a-z0-9]{6,16})$/);
    if (m) {
      const stub = env.MATCH.get(env.MATCH.idFromName(m[1]));
      return stub.fetch(new Request(request.url, { headers, method: 'GET' }));
    }
    return json({ error: 'not found' }, 404);
  }
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return json({ error: 'not found' }, 404);
}

// ---------- Lobby: presence, invites ----------
const INVITE_TTL = 15 * 60 * 1000;
export class LobbyCore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  socketsOf(uid) { return this.ctx.getWebSockets('u' + uid); }
  isOnline(uid) { return this.socketsOf(uid).length > 0; }
  sendTo(uid, msg) { const s = JSON.stringify(msg); for (const ws of this.socketsOf(uid)) { try { ws.send(s); } catch (e) { /* closed */ } } }

  async fetch(request) {
    const user = JSON.parse(decodeURIComponent(request.headers.get('x-user')));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['u' + user.id]);
    server.serializeAttachment(user);
    const friends = await friendIds(this.env.DB, user.id);
    const online = friends.filter(f => this.isOnline(f));
    server.send(JSON.stringify({ type: 'online', ids: online }));
    for (const f of online) this.sendTo(f, { type: 'presence', id: user.id, online: true });
    // pending invitations for this user
    const all = await this.ctx.storage.list({ prefix: 'inv:' });
    const now = Date.now();
    for (const [key, inv] of all) {
      if (now - inv.ts > INVITE_TTL) { await this.ctx.storage.delete(key); continue; }
      if (inv.to === user.id) server.send(JSON.stringify({ type: 'invited', matchId: inv.id, from: inv.from }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const me = ws.deserializeAttachment();
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    const env = this.env;
    if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
    if (msg.type === 'invite') {
      const to = Number(msg.to);
      if (!(await areFriends(env.DB, me.id, to))) { ws.send(JSON.stringify({ type: 'error', text: 'Это не твой друг' })); return; }
      const id = randomId();
      const inv = { id, from: { id: me.id, name: me.name, photo: me.photo }, to, ts: Date.now() };
      await this.ctx.storage.put('inv:' + id, inv);
      const online = this.isOnline(to);
      if (online) this.sendTo(to, { type: 'invited', matchId: id, from: inv.from });
      else await botSend(env, to, `${me.name} зовёт тебя сыграть партию в восьмёрку`, 'Принять', appLink(env, 'm' + id));
      ws.send(JSON.stringify({ type: 'inviteSent', matchId: id, to, online }));
      return;
    }
    if (msg.type === 'accept') {
      const inv = await this.ctx.storage.get('inv:' + msg.matchId);
      if (!inv || inv.to !== me.id || Date.now() - inv.ts > INVITE_TTL) {
        ws.send(JSON.stringify({ type: 'error', text: 'Приглашение уже не действует' })); return;
      }
      await this.ctx.storage.delete('inv:' + inv.id);
      const players = [inv.from, { id: me.id, name: me.name, photo: me.photo }];
      const stub = env.MATCH.get(env.MATCH.idFromName(inv.id));
      await stub.fetch(new Request('https://match/init', { method: 'POST', body: JSON.stringify({ id: inv.id, players }) }));
      const start = { type: 'start', matchId: inv.id };
      this.sendTo(inv.from.id, start); this.sendTo(me.id, start);
      return;
    }
    if (msg.type === 'decline' || msg.type === 'cancel') {
      const inv = await this.ctx.storage.get('inv:' + msg.matchId);
      if (!inv) return;
      if (msg.type === 'decline' && inv.to === me.id) {
        await this.ctx.storage.delete('inv:' + inv.id);
        this.sendTo(inv.from.id, { type: 'declined', matchId: inv.id, by: me.name });
      }
      if (msg.type === 'cancel' && inv.from.id === me.id) {
        await this.ctx.storage.delete('inv:' + inv.id);
        this.sendTo(inv.to, { type: 'cancelled', matchId: inv.id });
      }
      return;
    }
    if (msg.type === 'befriend') { // both are online and one just used the other's link: tell the other side
      const other = Number(msg.id);
      if (await areFriends(env.DB, me.id, other)) this.sendTo(other, { type: 'friendAdded', friend: { id: me.id, name: me.name, photo_url: me.photo } });
      return;
    }
  }

  async webSocketClose(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    const still = this.socketsOf(me.id).filter(s => s !== ws);
    if (still.length) return;
    const friends = await friendIds(this.env.DB, me.id);
    for (const f of friends) this.sendTo(f, { type: 'presence', id: me.id, online: false });
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}

// ---------- Match room ----------
const TURN_MS = 60 * 1000;
export class MatchCore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async load() { return (await this.ctx.storage.get('room')) || null; }
  async save(room) { await this.ctx.storage.put('room', room); }
  sockets(idx) { return this.ctx.getWebSockets(idx === undefined ? undefined : 'p' + idx); }
  send(idx, msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets('p' + idx)) { try { ws.send(s); } catch (e) { /* closed */ } } }
  broadcast(msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) { /* closed */ } } }
  online() { return [0, 1].map(i => this.ctx.getWebSockets('p' + i).length > 0); }
  stateMsg(room, idx) {
    return { type: 'state', id: room.id, you: idx, players: room.players, match: room.m, deadline: room.deadline,
      online: this.online(), rematch: room.rematch, now: Date.now() };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      const body = await request.json();
      let room = await this.load();
      if (!room) {
        const breaker = Math.random() < 0.5 ? 0 : 1;
        room = { id: body.id, players: body.players, m: new Match(breaker).toJSON(), deadline: Date.now() + TURN_MS + 30000,
          rematch: [false, false], recorded: false, created: Date.now() };
        await this.save(room);
        await this.ctx.storage.setAlarm(room.deadline);
      }
      return new Response('ok');
    }
    const user = JSON.parse(decodeURIComponent(request.headers.get('x-user') || 'null'));
    const room = await this.load();
    if (!room) return new Response('no such match', { status: 404 });
    const idx = room.players.findIndex(p => p.id === user.id);
    if (idx < 0) return new Response('not a player', { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['p' + idx]);
    server.serializeAttachment({ uid: user.id, idx });
    const wasEmpty = !this.online()[1 - idx] && this.ctx.getWebSockets('p' + idx).length === 1;
    if (room.m.game.winner === null && wasEmpty && room.deadline < Date.now() + 15000) {
      // coming back to a sleeping match: give a fresh shot clock
      room.deadline = Date.now() + TURN_MS; await this.save(room); await this.ctx.storage.setAlarm(room.deadline);
    }
    server.send(JSON.stringify(this.stateMsg(room, idx)));
    this.send(1 - idx, { type: 'presence', idx, online: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const { idx } = ws.deserializeAttachment();
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
    const room = await this.load();
    if (!room) return;
    const m = Match.from(room.m);
    const g = m.game;
    const myTurn = g.turn === idx && g.winner === null;
    if (msg.type === 'aim' || msg.type === 'place') {
      if (myTurn) this.send(1 - idx, { ...msg, idx });
      return;
    }
    if (msg.type === 'placeDone') {
      if (!myTurn) return;
      if (m.place(Number(msg.x), Number(msg.y))) {
        room.m = m.toJSON(); await this.save(room);
        this.broadcast({ type: 'placed', x: Number(msg.x), y: Number(msg.y), idx });
      } else ws.send(JSON.stringify(this.stateMsg(room, idx)));
      return;
    }
    if (msg.type === 'shot') {
      if (!myTurn || Number(msg.seq) !== m.seq) { ws.send(JSON.stringify(this.stateMsg(room, idx))); return; }
      const r = this.env.SERVER_PHYSICS === '1'
        ? m.shoot(msg.shot)
        : m.applyReported(msg.shot, msg.end, msg.log, msg.simTime);
      if (!r) { ws.send(JSON.stringify(this.stateMsg(room, idx))); return; }
      room.m = m.toJSON();
      room.deadline = Date.now() + Math.min(40, r.simTime) * 1000 + TURN_MS + 3000;
      await this.save(room);
      this.broadcast({ type: 'shot', idx, ...r, deadline: room.deadline, now: Date.now() });
      if (m.game.winner !== null) await this.finishMatch(room);
      else await this.ctx.storage.setAlarm(room.deadline);
      return;
    }
    if (msg.type === 'resign') {
      if (g.winner !== null) return;
      g.winner = 1 - idx; m.game = g; room.m = m.toJSON(); await this.save(room);
      this.broadcast({ type: 'resigned', idx, game: g });
      await this.finishMatch(room);
      return;
    }
    if (msg.type === 'rematch') {
      if (g.winner === null) return;
      room.rematch[idx] = true;
      if (room.rematch[0] && room.rematch[1]) {
        const loser = 1 - g.winner;
        room.m = new Match(loser).toJSON();
        room.rematch = [false, false]; room.recorded = false;
        room.deadline = Date.now() + TURN_MS;
        await this.save(room);
        await this.ctx.storage.setAlarm(room.deadline);
        for (const i of [0, 1]) this.send(i, this.stateMsg(room, i));
      } else {
        await this.save(room);
        this.broadcast({ type: 'rematch', rematch: room.rematch });
      }
      return;
    }
    if (msg.type === 'emote') { this.send(1 - idx, { type: 'emote', idx, text: String(msg.text || '').slice(0, 40) }); return; }
  }

  async finishMatch(room) {
    if (room.recorded) return;
    room.recorded = true;
    await this.save(room);
    const g = room.m.game;
    const winnerId = room.players[g.winner].id;
    const db = this.env.DB;
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO matches (id, p0, p1, winner, created_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(room.id + ':' + now, room.players[0].id, room.players[1].id, winnerId, room.created, now),
      db.prepare('UPDATE users SET games = games + 1 WHERE id IN (?1, ?2)').bind(room.players[0].id, room.players[1].id),
      db.prepare('UPDATE users SET wins = wins + 1 WHERE id = ?1').bind(winnerId),
    ]);
  }

  async alarm() {
    const room = await this.load();
    if (!room || room.m.game.winner !== null) return;
    if (Date.now() < room.deadline - 500) { await this.ctx.storage.setAlarm(room.deadline); return; }
    const on = this.online();
    if (!on[0] && !on[1]) return; // nobody here: the clock restarts when someone comes back
    const m = Match.from(room.m);
    const r = m.timeout();
    room.m = m.toJSON();
    room.deadline = Date.now() + TURN_MS;
    await this.save(room);
    this.broadcast({ type: 'timeout', ...r, deadline: room.deadline, now: Date.now() });
    await this.ctx.storage.setAlarm(room.deadline);
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    const left = this.ctx.getWebSockets('p' + a.idx).filter(s => s !== ws).length;
    if (!left) this.send(1 - a.idx, { type: 'presence', idx: a.idx, online: false });
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}
