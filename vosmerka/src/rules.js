// 8-ball rules, shared by the client (local game) and the server (online game).
// Classic rules: groups are decided by the first legal pot after the break, the 8 goes last,
// any foul gives the opponent ball in hand anywhere on the table.
(function (root) {
  'use strict';
  const SOLIDS = 'solids', STRIPES = 'stripes';
  const groupOf = id => (id >= 1 && id <= 7 ? SOLIDS : id >= 9 && id <= 15 ? STRIPES : null);
  const other = g => (g === SOLIDS ? STRIPES : SOLIDS);
  const GROUP_NAME = { solids: 'сплошные', stripes: 'полосатые' };

  // physics events of one shot -> compact log
  function shotLog(events) {
    let firstHit = null, railAfterContact = false, contact = false;
    const pocketed = [];
    for (const e of events) {
      if (e.type === 'ball') {
        if (!contact && (e.a === 0 || e.b === 0)) { firstHit = e.a === 0 ? e.b : e.a; contact = true; }
        else if (contact) { /* later contacts don't matter */ }
      } else if (e.type === 'cushion') {
        if (contact) railAfterContact = true;
      } else if (e.type === 'pocket') {
        if (!pocketed.includes(e.id)) pocketed.push(e.id);
        if (contact && e.id !== 0) railAfterContact = true; // a pot satisfies the rail requirement
      }
    }
    return { firstHit, railAfterContact, pocketed, scratch: pocketed.includes(0) };
  }

  function newGame(breaker) {
    return {
      turn: breaker,          // 0 or 1
      groups: [null, null],   // 'solids' | 'stripes'
      isBreak: true,
      ballInHand: false,      // the player whose turn it is may place the cue ball
      winner: null,           // 0 | 1 | null
      onTable: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      shots: 0,
    };
  }

  function remaining(g, group) { return g.onTable.filter(id => groupOf(id) === group).length; }

  // returns { game, msg, foul, respot8, respotCue }
  function applyShot(game, log) {
    const g = JSON.parse(JSON.stringify(game));
    const me = g.turn, opp = 1 - me;
    const myGroup = g.groups[me];
    const wasBreak = g.isBreak;
    const clearedBefore = myGroup ? remaining(g, myGroup) === 0 : false;
    const potted = log.pocketed.filter(id => id !== 0);
    g.onTable = g.onTable.filter(id => !potted.includes(id));
    g.shots++;
    g.isBreak = false;

    let foul = null;
    if (log.scratch) foul = 'Фол: биток в лузе';
    else if (log.firstHit === null) foul = 'Фол: биток не задел ни одного шара';
    else if (!wasBreak) {
      if (myGroup) {
        const legalFirst = clearedBefore ? 8 : null;
        if (legalFirst === 8 && log.firstHit !== 8) foul = 'Фол: первым нужно задеть восьмёрку';
        else if (legalFirst === null && groupOf(log.firstHit) !== myGroup) foul = 'Фол: первым задет чужой шар';
      } else if (log.firstHit === 8) foul = 'Фол: восьмёрку нельзя задевать первой';
      if (!foul && potted.length === 0 && !log.railAfterContact) foul = 'Фол: после касания ни один шар не дошёл до борта';
    }

    const res = { game: g, msg: '', foul: !!foul, respot8: false, respotCue: log.scratch };

    // the eight
    if (potted.includes(8)) {
      if (wasBreak) {
        // 8 on the break is re-spotted, the break is evaluated as usual
        g.onTable.push(8); g.onTable.sort((a, b) => a - b);
        res.respot8 = true;
      } else if (myGroup && clearedBefore && !foul) {
        g.winner = me; res.msg = 'Восьмёрка в лузе. Победа';
        return res;
      } else {
        g.winner = opp;
        res.msg = foul ? 'Восьмёрка забита с фолом. Поражение' : 'Восьмёрка забита раньше времени. Поражение';
        return res;
      }
    }

    if (foul) {
      g.turn = opp; g.ballInHand = true;
      res.msg = foul;
      return res;
    }
    g.ballInHand = false;

    // open table after the break: first legal pot decides the groups
    const pottedNo8 = potted.filter(id => id !== 8);
    let assigned = '';
    if (!g.groups[me] && !wasBreak && pottedNo8.length) {
      const grp = groupOf(pottedNo8[0]);
      g.groups[me] = grp; g.groups[opp] = other(grp);
      assigned = 'Твои — ' + GROUP_NAME[grp]; res.assigned = grp;
    }
    const mine = g.groups[me];
    const keep = wasBreak ? pottedNo8.length > 0
      : mine ? pottedNo8.some(id => groupOf(id) === mine) : false;
    if (!keep) g.turn = opp;
    res.msg = assigned || (keep ? (wasBreak ? 'Забил на разбое, бьёшь ещё' : 'Забил, бьёшь ещё') : '');
    return res;
  }

  const api = { shotLog, newGame, applyShot, groupOf, remaining, GROUP_NAME, SOLIDS, STRIPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PoolRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
