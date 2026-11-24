// Match engine: table state + rules + full-shot simulation. Same code runs in the browser
// (hot-seat game, and replaying online shots) and on the server (authoritative online game).
(function (root) {
  'use strict';
  const PP = typeof module !== 'undefined' && module.exports ? require('./physics.js') : root.PoolPhysics;
  const PR = typeof module !== 'undefined' && module.exports ? require('./rules.js') : root.PoolRules;
  const { C, World, strike } = PP;
  const R = C.R, HX = C.L / 2, HY = C.W / 2;
  const HEAD = [-C.L / 4, 0], FOOT = [C.L / 4, 0];

  const round = v => Math.round(v * 1e6) / 1e6;
  function snapshot(world) {
    return world.balls.map(b => ({ id: b.id, x: round(b.x), y: round(b.y), on: b.on }));
  }
  function loadBalls(world, balls) {
    world.balls = balls.map(s => ({ id: s.id, x: s.x, y: s.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: s.on, moving: false, pocketed: null }));
  }
  function free(balls, x, y, ignoreId) {
    return balls.every(b => !b.on || b.id === ignoreId || Math.hypot(b.x - x, b.y - y) >= 2 * R + 0.0005);
  }
  function validPlacement(balls, x, y, table) {
    if (!isFinite(x) || !isFinite(y)) return false;
    if (Math.abs(x) > HX - R - 0.001 || Math.abs(y) > HY - R - 0.001) return false;
    for (const h of table.holes) if (Math.hypot(x - h.x, y - h.y) < h.r + R) return false;
    return free(balls, x, y, 0);
  }
  // nearest free spot along a line, used for the 8 after the break and for the cue ball after a scratch
  function spotNear(balls, x0, y0, dirX, ignoreId) {
    for (let k = 0; k < 60; k++) {
      for (const s of [1, -1]) {
        const x = x0 + s * dirX * k * (2 * R + 0.001);
        if (Math.abs(x) < HX - R && free(balls, x, y0, ignoreId)) return [x, y0];
      }
    }
    return [x0, y0];
  }

  function Match(breaker) {
    const w = new World();
    w.rack();
    this.table = w.table;
    this.balls = snapshot(w);
    this.game = PR.newGame(breaker || 0);
    this.seq = 0;
  }
  Match.from = function (obj) {
    const m = Object.create(Match.prototype);
    Object.assign(m, obj);
    m.table = new World().table;
    return m;
  };
  Match.prototype.toJSON = function () {
    return { balls: this.balls, game: this.game, seq: this.seq };
  };

  Match.prototype.place = function (x, y) {
    if (!this.game.ballInHand) return false;
    if (!validPlacement(this.balls, x, y, this.table)) return false;
    const cb = this.balls.find(b => b.id === 0);
    cb.x = round(x); cb.y = round(y); cb.on = true;
    return true;
  };

  function cleanShot(shot) {
    return {
      aim: Number(shot.aim) || 0,
      speed: Math.max(0.2, Math.min(6.5, Number(shot.speed) || 0)),
      a: Math.max(-0.5, Math.min(0.5, Number(shot.a) || 0)),
      b: Math.max(-0.5, Math.min(0.5, Number(shot.b) || 0)),
    };
  }
  Match.prototype.prepare = function () {
    const cb = this.balls.find(b => b.id === 0);
    if (!cb.on) { // scratch happened earlier and the player did not move it: put it on the head spot
      const [x, y] = spotNear(this.balls, HEAD[0], HEAD[1], -1, 0);
      cb.x = x; cb.y = y; cb.on = true;
    }
  };
  // pure physics of one shot from the current table: { end, log, simTime }
  Match.prototype.simulate = function (shot) {
    this.prepare();
    const s = cleanShot(shot);
    const w = new World();
    loadBalls(w, this.balls);
    strike(w.balls.find(x => x.id === 0), s.aim, s.speed, s.a, s.b);
    let t = 0;
    const events = [];
    while (w.anyMoving() && t < 40) {
      w.step(1 / 60); t += 1 / 60;
      for (const e of w.events) events.push(e);
      w.events.length = 0;
    }
    for (const x of w.balls) { x.vx = x.vy = x.wx = x.wy = x.wz = 0; x.moving = false; }
    return { end: snapshot(w), log: PR.shotLog(events), simTime: round(t) };
  };
  // apply a finished shot (simulated here or reported by the shooter's phone) to rules and table
  Match.prototype.finish = function (shot, end, log, simTime) {
    const g = this.game;
    const start = this.balls.map(x => ({ ...x }));
    const res = PR.applyShot(g, log);
    this.game = res.game;
    end = end.map(x => ({ id: x.id, x: round(x.x), y: round(x.y), on: !!x.on }));
    if (res.respot8) {
      const e8 = end.find(x => x.id === 8);
      const [x, y] = spotNear(end, FOOT[0], FOOT[1], 1, 8);
      e8.x = x; e8.y = y; e8.on = true;
    }
    if (res.respotCue) {
      const c0 = end.find(x => x.id === 0);
      const [x, y] = spotNear(end, HEAD[0], HEAD[1], -1, 0);
      c0.x = x; c0.y = y; c0.on = true;
    }
    this.balls = end;
    this.seq++;
    return {
      seq: this.seq, shot: cleanShot(shot), start, end, log,
      msg: res.msg, foul: res.foul, assigned: res.assigned || null, shooter: g.turn,
      game: this.game, simTime: round(simTime || 0),
    };
  };
  // authoritative: simulate here
  Match.prototype.shoot = function (shot) {
    if (this.game.winner !== null) return null;
    const r = this.simulate(shot);
    return this.finish(shot, r.end, r.log, r.simTime);
  };
  // trusted shooter: check that the report is sane, then apply
  Match.prototype.applyReported = function (shot, end, log, simTime) {
    if (this.game.winner !== null) return null;
    if (!Array.isArray(end) || end.length !== 16) return null;
    const ids = new Set(end.map(b => b.id));
    for (let i = 0; i <= 15; i++) if (!ids.has(i)) return null;
    for (const b of end) {
      if (!isFinite(b.x) || !isFinite(b.y)) return null;
      if (b.on && (Math.abs(b.x) > HX + 0.01 || Math.abs(b.y) > HY + 0.01)) return null;
      const before = this.balls.find(x => x.id === b.id);
      if (!before.on && b.on && b.id !== 0) return null; // potted balls cannot come back
    }
    if (!log || !Array.isArray(log.pocketed)) return null;
    const clean = {
      firstHit: log.firstHit === null || log.firstHit === undefined ? null : Number(log.firstHit),
      railAfterContact: !!log.railAfterContact,
      pocketed: log.pocketed.map(Number).filter(n => n >= 0 && n <= 15),
      scratch: log.pocketed.map(Number).includes(0),
    };
    // a ball reported as potted must be off the table in the end positions, and vice versa
    for (const b of end) if (b.id !== 0 && (clean.pocketed.includes(b.id) === b.on)) {
      const before = this.balls.find(x => x.id === b.id);
      if (before.on) return null;
    }
    this.prepare();
    return this.finish(shot, end, clean, Number(simTime) || 0);
  };

  // time ran out: counts as a foul
  Match.prototype.timeout = function () {
    const g = this.game;
    if (g.winner !== null) return null;
    g.turn = 1 - g.turn; g.ballInHand = true; g.isBreak = false;
    this.seq++;
    return { seq: this.seq, msg: 'Время вышло. Шар в руке у соперника', game: g, end: this.balls };
  };

  const api = { Match, validPlacement, snapshot, loadBalls, spotNear, HEAD, FOOT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PoolMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
