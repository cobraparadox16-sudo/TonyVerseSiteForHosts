// ============================================================================
// GRIDLOCK GETAWAY — ai.js
// Traffic manager, police pursuit manager, wanted/heat system.
// ============================================================================
(function (GG) {
  'use strict';
  const { clamp } = GG.util;

  function roadNeighbors(world, tx, ty) {
    const out = [];
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + ox, ny = ty + oy;
      if (GG.inBounds(nx, ny)) {
        const t = world.getTile(nx, ny);
        if (t === GG.T.ROAD || t === GG.T.DIRT_ROAD) out.push({ tx: nx, ty: ny });
      }
    }
    return out;
  }
  function nearestRoadTile(world, x, y, maxR) {
    let tx0 = Math.floor(x / GG.TILE), ty0 = Math.floor(y / GG.TILE);
    for (let r = 0; r <= (maxR || 12); r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = tx0 + dx, ty = ty0 + dy;
          if (!GG.inBounds(tx, ty)) continue;
          const t = world.getTile(tx, ty);
          if (t === GG.T.ROAD || t === GG.T.DIRT_ROAD) return { tx, ty };
        }
      }
    }
    return { tx: tx0, ty: ty0 };
  }
  GG.nearestRoadTile = nearestRoadTile;

  // ---------------------------------------------------------------------
  // Traffic manager (civilian AI)
  // ---------------------------------------------------------------------
  function makeTrafficManager(world, rngSeed) {
    const rng = GG.mulberry32(rngSeed);
    const list = [];
    const TARGET = 16;
    let spawnCd = 0;

    function pickWaypoint(v) {
      const tx = Math.floor(v.x / GG.TILE), ty = Math.floor(v.y / GG.TILE);
      const opts = roadNeighbors(world, tx, ty);
      if (!opts.length) return { x: v.x, y: v.y };
      // prefer continuing roughly the same direction
      let best = opts[0], bestScore = -Infinity;
      for (const o of opts) {
        const ang = Math.atan2(o.ty - ty, o.tx - tx);
        const score = Math.cos(ang - v.angle) + rng() * 0.6;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      return { x: best.tx * GG.TILE + GG.TILE / 2, y: best.ty * GG.TILE + GG.TILE / 2 };
    }

    function trySpawn(player) {
      if (list.length >= TARGET) return;
      const ang = rng() * Math.PI * 2;
      const dist = 380 + rng() * 420;
      const px = player.x + Math.cos(ang) * dist, py = player.y + Math.sin(ang) * dist;
      const { tx, ty } = nearestRoadTile(world, px, py, 8);
      if (Math.hypot(tx * GG.TILE - player.x, ty * GG.TILE - player.y) < 260) return;
      const civ = GG.VEHICLES.filter(v => v.category === 'civilian');
      const def = civ[Math.floor(rng() * civ.length)];
      const v = GG.spawnVehicle(def.id, tx * GG.TILE + GG.TILE / 2, ty * GG.TILE + GG.TILE / 2, rng() * Math.PI * 2, { driver: 'ai-traffic' });
      v.speed = v.phys.top * 0.4;
      v.waypoint = pickWaypoint(v);
      list.push(v);
    }

    return {
      list,
      update(dt, player, world2) {
        spawnCd -= dt;
        if (spawnCd <= 0) { trySpawn(player); spawnCd = 0.5 + rng() * 0.6; }
        for (let i = list.length - 1; i >= 0; i--) {
          const v = list[i];
          const d = Math.hypot(v.x - player.x, v.y - player.y);
          if (d > 1250 || (v.wrecked && v.despawnAt !== undefined && performance.now() > v.despawnAt)) {
            list.splice(i, 1); continue;
          }
          if (v.wrecked) {
            if (v.despawnAt === undefined) v.despawnAt = performance.now() + 9000;
            continue;
          }
          if (!v.waypoint || Math.hypot(v.waypoint.x - v.x, v.waypoint.y - v.y) < 26) {
            v.waypoint = pickWaypoint(v);
          }
          GG.steerToward(v, v.waypoint.x, v.waypoint.y, dt, { allowReverse: true });
          v.throttleInput *= 0.72; // civilians drive calmer
          GG.avoidObstacles(v, world2, dt);
          // slow for nearby traffic/police ahead
          for (const other of list) {
            if (other === v || other.wrecked) continue;
            const dd = Math.hypot(other.x - v.x, other.y - v.y);
            if (dd < 55 && Math.cos(Math.atan2(other.y - v.y, other.x - v.x) - v.angle) > 0.6) {
              v.throttleInput = Math.min(v.throttleInput, 0.15);
            }
          }
        }
      }
    };
  }
  GG.makeTrafficManager = makeTrafficManager;

  // ---------------------------------------------------------------------
  // Police manager
  // ---------------------------------------------------------------------
  function makePoliceManager(world, rngSeed) {
    const rng = GG.mulberry32(rngSeed + 777);
    const list = [];
    let spawnCd = 1.2;

    function tierFor(level) {
      return GG.WANTED_TIERS[clamp(level - 1, 0, 9)];
    }

    function spawnUnit(player, level) {
      const tier = tierFor(level);
      const pursuit = GG.VEHICLES.filter(v => v.category === 'pursuit' && v.tier <= tier.tier);
      const def = pursuit[Math.floor(rng() * pursuit.length)] || GG.VEHICLES.find(v => v.category === 'pursuit');
      const aheadBias = rng() < 0.55;
      let ang;
      if (aheadBias) {
        const heading = Math.atan2(Math.sin(player.angle), Math.cos(player.angle));
        ang = heading + (rng() - 0.5) * 1.4;
      } else {
        ang = rng() * Math.PI * 2;
      }
      const dist = 340 + rng() * 260;
      const px = player.x + Math.cos(ang) * dist, py = player.y + Math.sin(ang) * dist;
      const { tx, ty } = nearestRoadTile(world, px, py, 10);
      if (Math.hypot(tx * GG.TILE - player.x, ty * GG.TILE - player.y) < 260) return;
      const roll = rng();
      let role = 'pursue';
      if (level >= 3 && roll < 0.22) role = 'roadblock';
      else if (roll < 0.55) role = 'intercept';
      const v = GG.spawnVehicle(def.id, tx * GG.TILE + GG.TILE / 2, ty * GG.TILE + GG.TILE / 2, rng() * Math.PI * 2, { driver: 'ai-police', role });
      v.speedMul = tier.speedMul;
      v.flankSign = list.length % 2 === 0 ? 1 : -1;
      list.push(v);
    }

    return {
      list,
      update(dt, player, world2, wantedLevel, game) {
        if (wantedLevel <= 0) {
          for (const v of list) { v.throttleInput = 0; v.aiState = 'disengage'; }
        }
        const tier = tierFor(Math.max(1, wantedLevel));
        spawnCd -= dt;
        if (wantedLevel > 0 && spawnCd <= 0 && list.filter(v => !v.wrecked).length < tier.maxUnits) {
          spawnUnit(player, wantedLevel);
          spawnCd = tier.spawnRate * (0.7 + rng() * 0.6);
        }
        for (let i = list.length - 1; i >= 0; i--) {
          const v = list[i];
          if (v.wrecked) {
            if (v.despawnAt === undefined) v.despawnAt = performance.now() + 11000;
            else if (performance.now() > v.despawnAt) list.splice(i, 1);
            continue;
          }
          const d = Math.hypot(v.x - player.x, v.y - player.y);
          if (wantedLevel <= 0 && d > 500) { list.splice(i, 1); continue; }
          if (d > 1500) { list.splice(i, 1); continue; }

          if (wantedLevel <= 0) {
            v.throttleInput *= 0.9;
            continue;
          }

          const leadT = 1.1;
          const pvx = Math.cos(player.angle) * player.speed, pvy = Math.sin(player.angle) * player.speed;
          const predX = player.x + pvx * leadT, predY = player.y + pvy * leadT;

          if (v.role === 'roadblock') {
            if (!v.blockPos || v.blockTimer === undefined) v.blockTimer = 0;
            v.blockTimer += dt;
            if (!v.blockPos || v.blockTimer > 13) {
              const bx = player.x + pvx * 2.4, by = player.y + pvy * 2.4;
              const rt = nearestRoadTile(world2, bx, by, 8);
              v.blockPos = { x: rt.tx * GG.TILE + GG.TILE / 2, y: rt.ty * GG.TILE + GG.TILE / 2 };
              v.blockTimer = 0;
            }
            const dd = Math.hypot(v.blockPos.x - v.x, v.blockPos.y - v.y);
            if (dd > 20) {
              GG.steerToward(v, v.blockPos.x, v.blockPos.y, dt, { stopDist: 20 });
            } else {
              v.throttleInput = 0; v.steerInput = 0;
            }
            if (d < 90) v.role = 'pursue'; // engage directly once player is close
          } else if (v.role === 'intercept') {
            GG.steerToward(v, predX, predY, dt);
          } else {
            const perp = player.angle + Math.PI / 2;
            const flank = (v.flankSign || 1) * clamp(60 - d * 0.06, -10, 60);
            const fx = player.x + Math.cos(perp) * flank * 0.3;
            const fy = player.y + Math.sin(perp) * flank * 0.3;
            GG.steerToward(v, predX * 0.7 + fx * 0.3, predY * 0.7 + fy * 0.3, dt);
          }
          GG.avoidObstacles(v, world2, dt);
        }
      },
      countActive() { return list.filter(v => !v.wrecked).length; }
    };
  }
  GG.makePoliceManager = makePoliceManager;

  // ---------------------------------------------------------------------
  // Wanted / heat system
  // ---------------------------------------------------------------------
  function makeWantedSystem() {
    let heat = 0; // 0..1000
    let chopperLostTimer = 0;
    return {
      get level() { return Math.min(10, Math.ceil(heat / 100)); },
      get heat() { return heat; },
      get frac() { return (heat % 100) / 100; },
      add(amount) { heat = clamp(heat + amount, 0, 1000); },
      set(level) { heat = level * 100; },
      reset() { heat = 0; chopperLostTimer = 0; },
      update(dt, player, world, policeList) {
        const lvl = this.level;
        const tier = lvl > 0 ? GG.WANTED_TIERS[lvl - 1] : null;
        const chopperActive = !!(tier && tier.chopper);
        const ptx = Math.floor(player.x / GG.TILE), pty = Math.floor(player.y / GG.TILE);
        const inCover = world.getTile(ptx, pty) === GG.T.FOREST || world.isBridge(ptx, pty);
        if (inCover) chopperLostTimer += dt; else chopperLostTimer = Math.max(0, chopperLostTimer - dt * 2);
        const hidden = chopperLostTimer > 2.2;
        let nearest = Infinity;
        for (const p of policeList) {
          if (p.wrecked) continue;
          const d = Math.hypot(p.x - player.x, p.y - player.y);
          if (d < nearest) nearest = d;
        }
        const sightRadius = hidden ? 90 : 320;
        const canCool = nearest > sightRadius;
        if (canCool && heat > 0) heat = clamp(heat - 16 * dt, 0, 1000);
        return { level: lvl, chopperActive: chopperActive && !hidden, hidden };
      }
    };
  }
  GG.makeWantedSystem = makeWantedSystem;

})(window.GG = window.GG || {});
