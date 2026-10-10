// ============================================================================
// GRIDLOCK GETAWAY — engine.js
// Vehicle physics, AI (traffic + police), collisions, particles, audio, save.
// ============================================================================
(function (GG) {
  'use strict';

  const TAU = Math.PI * 2;
  function normAngle(a) { a = a % TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  GG.util = { normAngle, clamp, lerp, dist2 };

  // ---- Stat -> physical constant mapping --------------------------------
  function effectiveStats(def, upgrades) {
    const s = Object.assign({}, def.stats);
    if (upgrades) {
      for (const key of GG.UPGRADE_KEYS) {
        const lvl = upgrades[key] || 0;
        const meta = GG.UPGRADE_META[key];
        s[meta.stat] = Math.min(100, s[meta.stat] + lvl * meta.perLevel);
      }
    }
    return s;
  }
  GG.effectiveStats = effectiveStats;

  function physFromStats(s) {
    const map = (v, lo, hi) => lo + (v / 100) * (hi - lo);
    return {
      accel: map(s.accel, 90, 270),
      top: map(s.top, 100, 350),
      brake: map(s.brake, 170, 430),
      turn: map(s.handling, 1.3, 3.4),
      hpMax: 100 + s.durability * 3.6,
      weightMul: 0.55 + s.weight / 100 * 0.9,
      offroadFactor: s.offroad / 100
    };
  }
  GG.physFromStats = physFromStats;

  const RADIUS = { civilian: 13, pursuit: 14, offroad: 15, water: 13, special: 13 };

  // ---- Vehicle entity ----------------------------------------------------
  let uidCounter = 1;
  function spawnVehicle(defId, x, y, angle, opts) {
    opts = opts || {};
    const def = GG.vehicleById(defId);
    const stats = effectiveStats(def, opts.upgrades);
    const phys = physFromStats(stats);
    let radius = RADIUS[def.category] || 13;
    if (def.narrow) radius = 9;
    if (def.smashesObstacles) radius = 19;
    return {
      uid: uidCounter++,
      defId, def, stats, phys,
      x, y, angle: angle || 0, speed: 0,
      steerInput: 0, throttleInput: 0, handbrake: false,
      hp: phys.hpMax, wrecked: false, hitCooldown: 0,
      radius,
      driver: opts.driver || null, // 'player' | 'ai-traffic' | 'ai-police' | null
      aiState: opts.aiState || 'patrol',
      aiTimer: 0, aiTarget: null, stuckTimer: 0, lastX: x, lastY: y, lastCheck: 0,
      role: opts.role || null, // for police: 'pursue'|'intercept'|'roadblock'
      inWater: false, offroad: false,
      flashTimer: 0,
      trail: []
    };
  }
  GG.spawnVehicle = spawnVehicle;

  // ---- Core physics update ------------------------------------------------
  function updateVehicle(v, dt, world, game) {
    v.hitCooldown = Math.max(0, (v.hitCooldown || 0) - dt);
    if (v.wrecked) {
      v.speed *= Math.pow(0.02, dt);
      v.flashTimer += dt;
      return;
    }
    const p = v.phys;
    const throttle = clamp(v.throttleInput, -1, 1);
    const steer = clamp(v.steerInput, -1, 1);

    // acceleration / braking
    let accelForce = 0;
    if (throttle > 0.02) accelForce = p.accel * throttle;
    else if (throttle < -0.02) {
      if (v.speed > 5) accelForce = -p.brake; // braking while moving forward
      else accelForce = -p.accel * 0.55 * Math.abs(throttle); // reverse
    } else {
      accelForce = -Math.sign(v.speed) * p.brake * 0.16; // gentle engine drag - let it coast
    }
    if (v.handbrake) accelForce -= Math.sign(v.speed) * p.brake * 0.4;

    v.speed += (accelForce / p.weightMul) * dt;

    const maxFwd = p.top * (v.speedMul || 1);
    const maxRev = -p.top * 0.42;
    v.speed = clamp(v.speed, maxRev, maxFwd);
    if (Math.abs(v.speed) < 3 && throttle === 0 && !v.handbrake) v.speed = 0;

    // turning: nimble from a crawl, full grip through mid-range, a bit looser flat-out
    const speedFrac = clamp(Math.abs(v.speed) / Math.max(1, maxFwd), 0, 1);
    const rampUp = clamp(speedFrac / 0.2, 0, 1);
    const topFalloff = 1 - 0.28 * clamp((speedFrac - 0.72) / 0.28, 0, 1);
    const turnAgility = v.handbrake ? p.turn * 1.3 : p.turn;
    const turnRate = turnAgility * (0.55 + 0.45 * rampUp) * topFalloff * (v.speed < 0 ? -1 : 1);
    v.angle += steer * turnRate * dt;

    // terrain
    const tx = Math.floor(v.x / GG.TILE), ty = Math.floor(v.y / GG.TILE);
    const water = world.isWater(tx, ty);
    v.inWater = water;
    v.offroad = !water && world.offroadPenaltyAt(tx, ty) > 0;
    if (water) {
      if (!v.def.waterOnly) {
        v.speed *= Math.pow(0.90, dt * 60);
        v.hp -= 12 * dt;
        game.onWaterDamage && game.onWaterDamage(v, dt);
      }
    } else if (v.def.waterOnly) {
      v.speed = clamp(v.speed, -30, 55); // beached
    } else {
      const penalty = world.offroadPenaltyAt(tx, ty);
      if (penalty > 0) {
        const mitigated = penalty * (1 - p.offroadFactor);
        v.speed *= (1 - mitigated * 0.02);
      }
    }

    // integrate position
    const prevX = v.x, prevY = v.y;
    const nx = v.x + Math.cos(v.angle) * v.speed * dt;
    const ny = v.y + Math.sin(v.angle) * v.speed * dt;
    const ntx = Math.floor(nx / GG.TILE), nty = Math.floor(ny / GG.TILE);
    // check a touch ahead of center (toward travel direction) too, so the body
    // stops at the wall instead of visibly poking through the corner first
    const noseX = nx + Math.sign(v.speed || 1) * Math.cos(v.angle) * v.radius * 0.7;
    const noseY = ny + Math.sign(v.speed || 1) * Math.sin(v.angle) * v.radius * 0.7;
    const noseTx = Math.floor(noseX / GG.TILE), noseTy = Math.floor(noseY / GG.TILE);

    let solid = world.isSolid(ntx, nty) || world.isSolid(noseTx, noseTy);
    if (solid && v.def.smashesObstacles &&
        world.getTile(ntx, nty) !== GG.T.BUILDING && world.getTile(noseTx, noseTy) !== GG.T.BUILDING) {
      solid = false; // this vehicle flattens trees instead of stopping for them
    }
    if (solid) {
      const impact = Math.abs(v.speed);
      if (impact > 22 && v.hitCooldown <= 0) {
        const dmg = impact * 0.05 * p.weightMul;
        v.hp -= dmg * (v.def.smashesObstacles ? 0.25 : 1);
        v.hitCooldown = 0.45;
        game.onImpact && game.onImpact(v, impact, prevX, prevY);
      }
      v.speed = -v.speed * 0.18;
      v.x = prevX; v.y = prevY;
    } else {
      v.x = nx; v.y = ny;
    }
    v.x = clamp(v.x, 0, world.size - 1);
    v.y = clamp(v.y, 0, world.size - 1);

    if (v.hp <= 0 && !v.wrecked) {
      v.wrecked = true;
      v.speed = 0;
      game.onWrecked && game.onWrecked(v);
    }

    // stuck detection (AI only)
    if (v.driver && v.driver !== 'player') {
      v.lastCheck += dt;
      if (v.lastCheck > 0.9) {
        const moved = Math.hypot(v.x - v.lastX, v.y - v.lastY);
        if (moved < 6 && Math.abs(throttle) > 0.3) v.stuckTimer += v.lastCheck;
        else v.stuckTimer = 0;
        v.lastX = v.x; v.lastY = v.y; v.lastCheck = 0;
      }
    }

    v.trail.push({ x: v.x, y: v.y });
    if (v.trail.length > 6) v.trail.shift();
  }
  GG.updateVehicle = updateVehicle;

  // ---- Vehicle vs vehicle collisions -------------------------------------
  function resolveVehicleCollisions(list, game) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const aInert = a.wrecked || a.parked, bInert = b.wrecked || b.parked;
        if (aInert && bInert) continue;
        const rr = a.radius + b.radius;
        const d2 = dist2(a.x, a.y, b.x, b.y);
        if (d2 < rr * rr && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          const overlap = rr - d;
          const nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
          const aW = aInert ? 40 : a.phys.weightMul, bW = bInert ? 40 : b.phys.weightMul;
          const totalW = aW + bW;
          a.x += nx * overlap * (bW / totalW);
          a.y += ny * overlap * (bW / totalW);
          b.x -= nx * overlap * (aW / totalW);
          b.y -= ny * overlap * (aW / totalW);
          const rel = Math.abs(a.speed) + Math.abs(b.speed);
          const onCooldown = a.hitCooldown > 0 || b.hitCooldown > 0;
          if (rel > 26 && !aInert && !bInert && !onCooldown) {
            // one damage tick per contact, not one per frame of contact
            const dmgA = rel * 0.026 * (bW / aW);
            const dmgB = rel * 0.026 * (aW / bW);
            a.hp -= dmgA; b.hp -= dmgB;
            a.speed *= 0.62; b.speed *= 0.62;
            a.hitCooldown = 0.45; b.hitCooldown = 0.45;
            game.onVehicleHit && game.onVehicleHit(a, b, rel);
            if (a.hp <= 0 && !a.wrecked) { a.wrecked = true; a.speed = 0; game.onWrecked && game.onWrecked(a); }
            if (b.hp <= 0 && !b.wrecked) { b.wrecked = true; b.speed = 0; game.onWrecked && game.onWrecked(b); }
          } else if (rel > 26 && !onCooldown) {
            // hitting a parked/wrecked hulk: the moving one takes a light bump, no explosion spam
            if (!aInert) a.speed *= 0.75; else b.speed *= 0.75;
            a.hitCooldown = 0.3; b.hitCooldown = 0.3;
            game.onImpact && game.onImpact(aInert ? b : a, rel, (a.x + b.x) / 2, (a.y + b.y) / 2);
          }
        }
      }
    }
  }
  GG.resolveVehicleCollisions = resolveVehicleCollisions;

  // ---- Simple AI steering helpers ----------------------------------------
  function steerToward(v, tx, ty, dt, opts) {
    opts = opts || {};
    const ang = Math.atan2(ty - v.y, tx - v.x);
    let diff = normAngle(ang - v.angle);
    const reverseOk = opts.allowReverse !== false;
    if (reverseOk && Math.abs(diff) > Math.PI * 0.72 && v.stuckTimer > 0.8) {
      // back up instead of doing a 3-point turn forever
      v.throttleInput = -0.8;
      v.steerInput = diff > 0 ? -1 : 1;
      return;
    }
    v.steerInput = clamp(diff / (Math.PI / 3.2), -1, 1);
    const d = Math.hypot(tx - v.x, ty - v.y);
    let throttle = Math.abs(diff) < Math.PI * 0.55 ? 1 : 0.45;
    if (opts.stopDist && d < opts.stopDist) throttle = 0;
    v.throttleInput = throttle;
  }
  GG.steerToward = steerToward;

  function lookaheadClear(v, world, dist) {
    const lx = v.x + Math.cos(v.angle) * dist;
    const ly = v.y + Math.sin(v.angle) * dist;
    return !world.isSolid(Math.floor(lx / GG.TILE), Math.floor(ly / GG.TILE));
  }
  GG.lookaheadClear = lookaheadClear;

  function avoidObstacles(v, world, dt) {
    const lookDist = 46 + Math.abs(v.speed) * 0.25;
    if (!lookaheadClear(v, world, lookDist)) {
      const leftClear = lookaheadClear({ x: v.x, y: v.y, angle: v.angle - 0.6 }, world, lookDist);
      const rightClear = lookaheadClear({ x: v.x, y: v.y, angle: v.angle + 0.6 }, world, lookDist);
      if (leftClear && !rightClear) v.steerInput = clamp(v.steerInput - 0.8, -1, 1);
      else if (rightClear && !leftClear) v.steerInput = clamp(v.steerInput + 0.8, -1, 1);
      else v.steerInput = (v.uid % 2 === 0 ? 1 : -1);
      v.throttleInput = Math.min(v.throttleInput, 0.5);
    }
  }
  GG.avoidObstacles = avoidObstacles;

  // ============================================================================
  // Particle system
  // ============================================================================
  function makeParticleSystem() {
    let list = [];
    return {
      spawn(p) { list.push(Object.assign({ life: 1, age: 0, vx: 0, vy: 0, size: 3 }, p)); },
      update(dt) {
        for (const p of list) {
          p.age += dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          p.vx *= Math.pow(p.drag || 0.9, dt * 60);
          p.vy *= Math.pow(p.drag || 0.9, dt * 60);
          if (p.gravity) p.vy += p.gravity * dt;
        }
        list = list.filter(p => p.age < p.life);
      },
      get all() { return list; },
      clear() { list = []; }
    };
  }
  GG.makeParticleSystem = makeParticleSystem;

  function burst(ps, x, y, n, opts) {
    opts = opts || {};
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (opts.minSp || 30) + Math.random() * (opts.maxSp || 90);
      ps.spawn({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: (opts.life || 0.5) + Math.random() * (opts.lifeVar || 0.3),
        size: (opts.size || 3) + Math.random() * (opts.sizeVar || 2),
        color: opts.color || '#ffb020',
        drag: opts.drag || 0.9,
        gravity: opts.gravity || 0,
        kind: opts.kind || 'dot'
      });
    }
  }
  GG.burst = burst;

  // ============================================================================
  // Audio engine — fully synthesized, no external assets
  // ============================================================================
  function makeAudio() {
    let ctx = null, master = null, sfxGain = null, musicGain = null;
    let engineOsc = null, engineGain = null, sirenOsc = null, sirenGain = null;
    let musicNodes = [];
    let enabled = true, sfxVol = 0.8, musicVol = 0.55, started = false;

    function ensure() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      sfxGain = ctx.createGain(); sfxGain.gain.value = sfxVol; sfxGain.connect(master);
      musicGain = ctx.createGain(); musicGain.gain.value = musicVol; musicGain.connect(master);
    }
    function resume() { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); started = true; }

    function noiseBuffer(dur) {
      const sr = ctx.sampleRate;
      const buf = ctx.createBuffer(1, sr * dur, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      return buf;
    }

    function crash(strength) {
      if (!enabled) return; ensure(); if (!ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(0.35);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900 + strength * 3;
      const g = ctx.createGain(); g.gain.value = clamp(strength / 260, 0.1, 1) * sfxVol;
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(); src.stop(ctx.currentTime + 0.36);
    }
    function ui(freq) {
      if (!enabled) return; ensure(); if (!ctx) return;
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq || 660;
      const g = ctx.createGain(); g.gain.value = 0.12 * sfxVol;
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
      o.connect(g); g.connect(master);
      o.start(); o.stop(ctx.currentTime + 0.1);
    }
    function splash() {
      if (!enabled) return; ensure(); if (!ctx) return;
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.4);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200;
      const g = ctx.createGain(); g.gain.value = 0.25 * sfxVol;
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      src.connect(f); f.connect(g); g.connect(master);
      src.start();
    }
    function startEngine() {
      ensure(); if (!ctx || engineOsc) return;
      engineOsc = ctx.createOscillator(); engineOsc.type = 'sawtooth'; engineOsc.frequency.value = 60;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 400;
      engineGain = ctx.createGain(); engineGain.gain.value = 0;
      engineOsc.connect(filt); filt.connect(engineGain); engineGain.connect(master);
      engineOsc.start();
    }
    function setEngine(speedFrac, active) {
      if (!engineOsc) return;
      const target = active ? clamp(0.05 + speedFrac * 0.13, 0, 0.2) * sfxVol : 0;
      engineGain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
      engineOsc.frequency.setTargetAtTime(55 + speedFrac * 210, ctx.currentTime, 0.06);
    }
    function startSiren() {
      ensure(); if (!ctx || sirenOsc) return;
      sirenOsc = ctx.createOscillator(); sirenOsc.type = 'sine'; sirenOsc.frequency.value = 700;
      sirenGain = ctx.createGain(); sirenGain.gain.value = 0;
      sirenOsc.connect(sirenGain); sirenGain.connect(master);
      sirenOsc.start();
    }
    let sirenPhase = 0;
    function setSiren(intensity, dt) {
      if (!sirenOsc) return;
      sirenPhase += dt * (2.4 + intensity * 1.4);
      const f = 640 + Math.sin(sirenPhase * TAU) * (140 + intensity * 60);
      sirenOsc.frequency.setTargetAtTime(f, ctx.currentTime, 0.02);
      sirenGain.gain.setTargetAtTime(clamp(intensity, 0, 1) * 0.14 * sfxVol, ctx.currentTime, 0.15);
    }

    // procedural pursuit music: layered arpeggio driven by wanted intensity
    let musicPlaying = false, musicStep = 0, musicTimer = 0;
    const scale = [0, 3, 5, 7, 10, 12, 15];
    function startMusic() {
      if (musicPlaying) return; ensure(); if (!ctx) return;
      musicPlaying = true; musicStep = 0; musicTimer = 0;
    }
    function stopMusic() {
      musicPlaying = false;
      musicNodes.forEach(n => { try { n.stop(); } catch (e) {} });
      musicNodes = [];
    }
    function tickMusic(dt, intensity) {
      if (!musicPlaying || !ctx) return;
      const bpm = 118 + intensity * 60;
      const stepDur = 60 / bpm / 2;
      musicTimer += dt;
      if (musicTimer >= stepDur) {
        musicTimer -= stepDur;
        musicStep++;
        const root = 110;
        const note = scale[(musicStep * 3) % scale.length];
        const freq = root * Math.pow(2, note / 12);
        const o = ctx.createOscillator(); o.type = intensity > 0.5 ? 'square' : 'triangle';
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.value = 0.001;
        g.gain.linearRampToValueAtTime(0.09 * musicVol * (0.5 + intensity), ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + stepDur * 0.9);
        o.connect(g); g.connect(musicGain);
        o.start(); o.stop(ctx.currentTime + stepDur);
        if (intensity > 0.35 && musicStep % 2 === 0) {
          const bass = ctx.createOscillator(); bass.type = 'sawtooth'; bass.frequency.value = root / 2;
          const bg = ctx.createGain(); bg.gain.value = 0.001;
          bg.gain.linearRampToValueAtTime(0.11 * musicVol * intensity, ctx.currentTime + 0.02);
          bg.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + stepDur * 1.6);
          bass.connect(bg); bg.connect(musicGain);
          bass.start(); bass.stop(ctx.currentTime + stepDur * 1.6);
        }
      }
    }
    return {
      resume, crash, ui, splash, startEngine, setEngine, startSiren, setSiren, startMusic, stopMusic, tickMusic,
      setSfxVol(v) { sfxVol = v; if (sfxGain) sfxGain.gain.value = v; },
      setMusicVol(v) { musicVol = v; if (musicGain) musicGain.gain.value = v; },
      setEnabled(v) { enabled = v; },
      get isStarted() { return started; }
    };
  }
  GG.makeAudio = makeAudio;

  // ============================================================================
  // Save manager
  // ============================================================================
  const SAVE_KEY = 'gridlockGetaway_save_v1';
  function defaultSave() {
    return {
      money: 900, xp: 0, level: 1,
      unlocked: ['civ_0'],
      activeVehicle: 'civ_0',
      character: 'vega',
      upgrades: {},
      achievements: {},
      dailyDate: '', dailyDone: {},
      settings: { sfx: 0.8, music: 0.55, invert: false },
      stats: { wrecks: 0, thefts: 0, maxWanted: 0, lifetimeEarnings: 0, bestSurvival: 0, missionsDone: 0, busts: 0 }
    };
  }
  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return defaultSave();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultSave(), parsed, {
        stats: Object.assign(defaultSave().stats, parsed.stats || {}),
        settings: Object.assign(defaultSave().settings, parsed.settings || {})
      });
    } catch (e) { return defaultSave(); }
  }
  function writeSave(s) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  GG.defaultSave = defaultSave;
  GG.loadSave = loadSave;
  GG.writeSave = writeSave;

  // ============================================================================
  // Mission generator
  // ============================================================================
  function genMission(rng, worldStructures) {
    const t = GG.MISSION_TYPES[Math.floor(rng() * GG.MISSION_TYPES.length)];
    const m = { type: t.type, label: t.label };
    if (t.type === 'survive') m.target = 30 + Math.floor(rng() * 90);
    if (t.type === 'checkpoints') m.target = 3 + Math.floor(rng() * 4);
    if (t.type === 'stunt') m.target = 6 + Math.floor(rng() * 10);
    m.desc = t.desc(m);
    m.reward = Math.round(t.reward(m));
    m.id = t.type + '_' + Math.floor(rng() * 1e6);
    return m;
  }
  GG.genMission = genMission;

})(window.GG = window.GG || {});
