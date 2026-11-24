// Pool physics engine: 2D table plane, full 3D ball spin.
// Units: meters, kilograms, seconds. Table plane is x (length), y (width), z up.
(function (root) {
  'use strict';

  const C = {
    R: 0.028575,            // ball radius (57.15 mm)
    M: 0.17,                // ball mass
    G: 9.81,
    MU_SLIDE: 0.2,          // cloth sliding friction
    MU_ROLL: 0.012,         // rolling resistance
    SPIN_DECEL: 9.0,        // rad/s^2, decay of vertical-axis spin (english)
    E_BALL: 0.95,           // ball-ball restitution
    MU_BALL: 0.06,          // ball-ball friction (throw)
    E_CUSHION: 0.8,         // cushion restitution at low speed
    MU_CUSHION: 0.3,       // cushion friction
    CUSHION_H: 0.0365,      // cushion nose height above cloth (~ 0.64 * diameter)
    L: 2.54, W: 1.27,       // 9 ft table playing area
    CUE_MASS: 0.54,
    DT: 1 / 2400,
  };
  C.I = 0.4 * C.M * C.R * C.R;

  // ---------- table geometry ----------
  function buildTable() {
    const L = C.L, W = C.W, hx = L / 2, hy = W / 2;
    const segs = [];   // cushion segments {a:[x,y], b:[x,y], jaw:bool}
    const holes = [];  // pocket holes {x,y,r}
    const deg = Math.PI / 180;

    // corner pockets
    const cornerMouth = 0.116, jawLen = 0.055, cornerJawAngle = 38 * deg;
    const a = cornerMouth / Math.SQRT2;
    const cornerPts = {};
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      // point on long rail and on short rail
      const p1 = [sx * (hx - a), sy * hy];
      const p2 = [sx * hx, sy * (hy - a)];
      // jaw directions (local frame mirrored)
      const d1 = [sx * Math.cos(cornerJawAngle), sy * Math.sin(cornerJawAngle)];
      const d2 = [sx * Math.sin(cornerJawAngle), sy * Math.cos(cornerJawAngle)];
      const j1 = [p1[0] + d1[0] * jawLen, p1[1] + d1[1] * jawLen];
      const j2 = [p2[0] + d2[0] * jawLen, p2[1] + d2[1] * jawLen];
      segs.push({ a: p1, b: j1, jaw: true }, { a: p2, b: j2, jaw: true });
      const off = 0.012;
      holes.push({ x: sx * (hx + off), y: sy * (hy + off), r: 0.056, kind: 'corner', sx, sy });
      cornerPts[sx + ',' + sy] = { p1, p2, j1, j2 };
    }
    // side pockets
    const sideMouth = 0.132, sideJawLen = 0.032, sideJawAngle = 76 * deg;
    const sidePts = {};
    for (const sy of [-1, 1]) {
      const pl = [-sideMouth / 2, sy * hy], pr = [sideMouth / 2, sy * hy];
      const jl = [pl[0] + Math.cos(sideJawAngle) * sideJawLen, pl[1] + sy * Math.sin(sideJawAngle) * sideJawLen];
      const jr = [pr[0] - Math.cos(sideJawAngle) * sideJawLen, pr[1] + sy * Math.sin(sideJawAngle) * sideJawLen];
      segs.push({ a: pl, b: jl, jaw: true }, { a: pr, b: jr, jaw: true });
      holes.push({ x: 0, y: sy * (hy + 0.042), r: 0.054, kind: 'side', sy });
      sidePts[sy] = { pl, pr, jl, jr };
    }
    // rails
    for (const sy of [-1, 1]) {
      segs.push({ a: [-hx + a, sy * hy], b: [-sideMouth / 2, sy * hy] });
      segs.push({ a: [sideMouth / 2, sy * hy], b: [hx - a, sy * hy] });
    }
    for (const sx of [-1, 1]) segs.push({ a: [sx * hx, -hy + a], b: [sx * hx, hy - a] });

    for (const s of segs) {
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
      s.len = Math.hypot(dx, dy);
      s.dir = [dx / s.len, dy / s.len];
    }
    return { segs, holes, cornerPts, sidePts };
  }

  // ---------- ball ----------
  function makeBall(id, x, y) {
    return { id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true, moving: false, pocketed: null };
  }

  // ---------- shot ----------
  // aim: unit direction angle (rad). power: cue speed m/s. tip: {a, b} offsets in units of R
  // (a: right english, b: up = follow). Returns nothing, sets cue ball state.
  function strike(ball, angle, cueSpeed, tipA, tipB) {
    const R = C.R, m = C.M;
    const maxOff = 0.5;
    let a = tipA, b = tipB;
    const mag = Math.hypot(a, b);
    if (mag > maxOff) { a *= maxOff / mag; b *= maxOff / mag; }
    const ar = a * R, br = b * R;
    // ball speed from cue impact (efficiency includes tip offset)
    const e = 0.75; // tip restitution
    const v = (1 + e) * cueSpeed / (1 + m / C.CUE_MASS + 2.5 * (a * a + b * b));
    // squirt: cue ball deflects opposite to english
    const squirt = -a * 0.05;
    const ang = angle + squirt;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const rx = dy, ry = -dx; // right vector
    const c = Math.sqrt(Math.max(0, R * R - ar * ar - br * br));
    // contact point relative to center (back of ball)
    const px = -c * dx + ar * rx, py = -c * dy + ar * ry, pz = br;
    const J = m * v; // impulse along d
    const Jx = J * dx, Jy = J * dy, Jz = 0;
    // w = (p x J) / I
    ball.wx = (py * Jz - pz * Jy) / C.I;
    ball.wy = (pz * Jx - px * Jz) / C.I;
    ball.wz = (px * Jy - py * Jx) / C.I;
    ball.vx = v * dx; ball.vy = v * dy;
    ball.moving = true;
  }

  // ---------- world ----------
  function World() {
    this.table = buildTable();
    this.balls = [];
    this.events = []; // {type, speed, id, ...}
    this.time = 0;
  }

  World.prototype.rack = function () {
    const R = C.R, gap = 1.0002;
    this.balls = [];
    this.balls.push(makeBall(0, -C.L / 4, 0));
    // standard 8-ball rack: 8 in the middle, back corners solid + stripe
    const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 13, 5, 14, 6, 15, 7];
    // rearranged so row 3 middle is 8 and back corners differ
    const rows = [[1], [10, 2], [3, 8, 11], [12, 5, 14, 4], [6, 13, 15, 9, 7]];
    void order;
    const footX = C.L / 4;
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        // tiny random jitter so breaks differ a little
        const jx = (Math.random() - 0.5) * 0.0002, jy = (Math.random() - 0.5) * 0.0002;
        const x = footX + i * R * Math.sqrt(3) * gap + jx;
        const y = (j - i / 2) * 2 * R * gap + jy;
        this.balls.push(makeBall(rows[i][j], x, y));
      }
    }
  };

  World.prototype.anyMoving = function () {
    for (const b of this.balls) if (b.on && b.moving) return true;
    return false;
  };

  // advance by total time t using fixed substeps
  World.prototype.step = function (t) {
    const dt = C.DT;
    let n = Math.max(1, Math.round(t / dt));
    for (let i = 0; i < n; i++) {
      this.substep(dt);
      this.time += dt;
      if (!this.anyMoving()) break;
    }
  };

  World.prototype.substep = function (dt) {
    const balls = this.balls;
    for (const b of balls) if (b.on && b.moving) cloth(b, dt);
    for (const b of balls) if (b.on && b.moving) { b.x += b.vx * dt; b.y += b.vy * dt; }
    // ball-ball
    for (let i = 0; i < balls.length; i++) {
      const A = balls[i];
      if (!A.on) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const B = balls[j];
        if (!B.on) continue;
        if (!A.moving && !B.moving) continue;
        ballBall(A, B, this.events);
      }
    }
    // cushions + pockets
    for (const b of balls) {
      if (!b.on || !b.moving) continue;
      for (const s of this.table.segs) cushion(b, s, this.events);
      for (const h of this.table.holes) {
        const dx = b.x - h.x, dy = b.y - h.y;
        if (dx * dx + dy * dy < h.r * h.r) {
          b.on = false; b.moving = false;
          b.pocketed = { hole: h, vx: b.vx, vy: b.vy, x: b.x, y: b.y, t: this.time };
          this.events.push({ type: 'pocket', id: b.id, speed: Math.hypot(b.vx, b.vy), hole: h });
          break;
        }
      }
    }
  };

  // cloth friction: sliding -> rolling, rolling resistance, spin decay
  function cloth(b, dt) {
    const R = C.R, m = C.M, g = C.G;
    // contact point velocity with cloth: u = v + w x (0,0,-R)
    let ux = b.vx - R * b.wy;
    let uy = b.vy + R * b.wx;
    const u = Math.hypot(ux, uy);
    if (u > 1e-4) {
      // sliding: friction impulse limited so slip does not reverse
      const jmax = C.MU_SLIDE * m * g * dt;
      const jneed = u * m / 3.5;
      const j = Math.min(jmax, jneed);
      const Px = -j * ux / u, Py = -j * uy / u;
      b.vx += Px / m; b.vy += Py / m;
      // dw = (r x P)/I, r = (0,0,-R): r x P = (R*Py, -R*Px, 0)
      b.wx += R * Py / C.I;
      b.wy += -R * Px / C.I;
    } else {
      // rolling: resistance decelerates, keep spin matched
      const v = Math.hypot(b.vx, b.vy);
      if (v > 0) {
        const dv = C.MU_ROLL * g * dt;
        const nv = Math.max(0, v - dv);
        b.vx *= nv / v; b.vy *= nv / v;
      }
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
    }
    // english decay
    if (b.wz !== 0) {
      const d = C.SPIN_DECEL * dt;
      b.wz = Math.abs(b.wz) <= d ? 0 : b.wz - Math.sign(b.wz) * d;
    }
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < 0.003 && u < 0.003 && Math.abs(b.wz) < 0.3) {
      b.vx = b.vy = b.wx = b.wy = b.wz = 0;
      b.moving = false;
    }
  }

  function ballBall(A, B, events) {
    const R = C.R, m = C.M;
    let nx = B.x - A.x, ny = B.y - A.y;
    const d2 = nx * nx + ny * ny;
    const minD = 2 * R;
    if (d2 >= minD * minD || d2 === 0) return;
    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    // separate
    const overlap = minD - d;
    A.x -= nx * overlap / 2; A.y -= ny * overlap / 2;
    B.x += nx * overlap / 2; B.y += ny * overlap / 2;
    const rvx = A.vx - B.vx, rvy = A.vy - B.vy;
    const vn = rvx * nx + rvy * ny; // >0 approaching
    if (vn <= 0) return;
    A.moving = B.moving = true;
    const Jn = (1 + C.E_BALL) * (m / 2) * vn;
    A.vx -= Jn / m * nx; A.vy -= Jn / m * ny;
    B.vx += Jn / m * nx; B.vy += Jn / m * ny;
    // tangential friction at contact (throw, spin transfer)
    // contact velocity of A at r=R n: v + w x r
    const cAx = A.vx + (-A.wz * R * ny), cAy = A.vy + (A.wz * R * nx);
    const cBx = B.vx + (B.wz * R * ny), cBy = B.vy + (-B.wz * R * nx);
    // plus contribution from wx, wy: (w x r).z only -> vertical, ignored in plane
    let sx = cAx - cBx, sy = cAy - cBy;
    const sn = sx * nx + sy * ny;
    sx -= sn * nx; sy -= sn * ny;
    // vertical slip from top/back spin also contributes to friction magnitude direction
    const szA = A.wx * R * ny - A.wy * R * nx;
    const szB = -(B.wx * R * ny - B.wy * R * nx);
    const sz = szA - szB;
    const s = Math.hypot(sx, sy, sz);
    if (s > 1e-6) {
      const jt = Math.min(C.MU_BALL * Jn, s * m / 7);
      const tx = sx / s, ty = sy / s, tz = sz / s;
      // impulse on A: P = -jt * t ; on B: +jt * t
      const Px = -jt * tx, Py = -jt * ty, Pz = -jt * tz;
      // linear: only planar part (vertical part absorbed by table)
      A.vx += Px / m; A.vy += Py / m;
      B.vx -= Px / m; B.vy -= Py / m;
      // angular: dw = (r x P)/I, rA = R n, rB = -R n
      const rAx = R * nx, rAy = R * ny;
      A.wx += (rAy * Pz) / C.I;
      A.wy += (-rAx * Pz) / C.I;
      A.wz += (rAx * Py - rAy * Px) / C.I;
      // B gets -P at -r: (-r) x (-P) = r x P
      B.wx += (rAy * Pz) / C.I;
      B.wy += (-rAx * Pz) / C.I;
      B.wz += (rAx * Py - rAy * Px) / C.I;
    }
    events.push({ type: 'ball', speed: vn, a: A.id, b: B.id, x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
  }

  function cushion(b, s, events) {
    const R = C.R, m = C.M;
    // closest point on segment
    const px = b.x - s.a[0], py = b.y - s.a[1];
    let t = px * s.dir[0] + py * s.dir[1];
    t = Math.max(0, Math.min(s.len, t));
    const cx = s.a[0] + s.dir[0] * t, cy = s.a[1] + s.dir[1] * t;
    let nx = b.x - cx, ny = b.y - cy;
    const d2 = nx * nx + ny * ny;
    if (d2 >= R * R || d2 === 0) return;
    const d = Math.sqrt(d2);
    nx /= d; ny /= d;
    b.x += nx * (R - d); b.y += ny * (R - d);
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    const speedIn = -vn;
    // restitution decreases with impact speed
    let e = C.E_CUSHION - 0.025 * speedIn;
    if (s.jaw) e -= 0.08;
    e = Math.max(0.55, e);
    const Jn = (1 + e) * m * speedIn;
    b.vx += Jn / m * nx; b.vy += Jn / m * ny;
    // contact point at nose, above center: r = -R*cos(th)*n + h*z
    const h = C.CUSHION_H - C.R;            // height of contact above ball center
    const rh = Math.sqrt(Math.max(0, R * R - h * h));
    const rx = -rh * nx, ry = -rh * ny, rz = h;
    // contact velocity v + w x r
    const cvx = b.vx + (b.wy * rz - b.wz * ry);
    const cvy = b.vy + (b.wz * rx - b.wx * rz);
    const cvz = (b.wx * ry - b.wy * rx);
    // tangential part relative to cushion (remove normal component)
    const cn = cvx * nx + cvy * ny;
    let tx = cvx - cn * nx, ty = cvy - cn * ny, tz = cvz;
    const tm = Math.hypot(tx, ty, tz);
    if (tm > 1e-6) {
      const jt = Math.min(C.MU_CUSHION * Jn, tm * m / 3.5);
      const Px = -jt * tx / tm, Py = -jt * ty / tm, Pz = -jt * tz / tm;
      b.vx += Px / m; b.vy += Py / m; // vertical linear part absorbed (no jumping)
      b.wx += (ry * Pz - rz * Py) / C.I;
      b.wy += (rz * Px - rx * Pz) / C.I;
      b.wz += (rx * Py - ry * Px) / C.I;
    }
    b.moving = true;
    events.push({ type: 'cushion', speed: speedIn, id: b.id, jaw: !!s.jaw, x: cx, y: cy });
  }

  const api = { C, World, strike, makeBall, buildTable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PoolPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);
