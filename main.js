// ============================================================================
// GRIDLOCK GETAWAY — main.js
// Bootstraps the game, owns the state machine + game loop, wires input,
// missions, progression, and effects together.
// ============================================================================
(function (GG) {
  'use strict';
  const { clamp, lerp } = GG.util;

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const mmCanvas = document.getElementById('minimap');
  const mmCtx = mmCanvas.getContext('2d');
  const speedCanvas = document.getElementById('speed-canvas');
  const speedCtx = speedCanvas.getContext('2d');

  let VW = window.innerWidth, VH = window.innerHeight;
  function resize() {
    VW = window.innerWidth; VH = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = VW * dpr; canvas.height = VH * dpr;
    canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const audio = GG.makeAudio();
  GG.audio = audio;

  // ---------------------------------------------------------------------
  // Game object
  // ---------------------------------------------------------------------
  const game = {
    state: 'menu', // menu | playing | paused
    running: false,
    save: GG.loadSave(),
    world: null,
    traffic: null,
    police: null,
    wanted: GG.makeWantedSystem(),
    particles: GG.makeParticleSystem(),
    camera: { x: 0, y: 0, shake: 0 },
    mode: 'drive', // 'drive' | 'foot'
    playerCar: null,
    ped: { x: 0, y: 0, angle: 0, speed: 0, hp: 100, phys: { hpMax: 100 }, wrecked: false, def: {}, radius: 8 },
    parked: [],
    minimapBitmap: null,
    timeScale: 1, slowTimer: 0,
    availableMissions: [], dailyMissions: [], activeMission: null,
    time: 0,
    lastImpactToast: 0
  };
  GG.game = game;

  Object.defineProperty(game, 'player', {
    get() { return this.mode === 'drive' && this.playerCar ? this.playerCar : this.ped; }
  });

  // ---- world / run lifecycle --------------------------------------------
  function newWorld(seed) {
    const world = GG.generateWorld(seed);
    return world;
  }

  function setupMenuWorld() {
    game.world = newWorld(Date.now() >>> 0);
    game.minimapBitmap = GG.buildMinimapBitmap(game.world);
    game.camera.x = game.world.spawn.x; game.camera.y = game.world.spawn.y;
    game.menuDrift = { a: Math.random() * 6.28, r: 0 };
  }

  function beginRun(freshWorld) {
    if (freshWorld || !game.world) {
      game.world = newWorld((Math.random() * 1e9) >>> 0);
      game.minimapBitmap = GG.buildMinimapBitmap(game.world);
    }
    const w = game.world;
    game.traffic = GG.makeTrafficManager(w, w.seed);
    game.police = GG.makePoliceManager(w, w.seed);
    game.wanted.reset();
    game.parked = [];
    game.particles.clear();
    game.mode = 'drive';
    const upg = game.save.upgrades[game.save.activeVehicle];
    game.playerCar = GG.spawnVehicle(game.save.activeVehicle, w.spawn.x, w.spawn.y, -Math.PI / 2, { driver: 'player', upgrades: upg });
    game.ped.x = w.spawn.x; game.ped.y = w.spawn.y;
    game.camera.x = w.spawn.x; game.camera.y = w.spawn.y;
    game.runStart = performance.now();
    game.state = 'playing'; game.running = true;
    audio.resume(); audio.startEngine(); audio.startSiren(); audio.startMusic();
    document.getElementById('hud').classList.remove('hidden');
    generateMissionPool();
    GG.UI.show('__none__');
    hideAllScreens();
  }

  function hideAllScreens() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  }

  game.enterWorld = function () { beginRun(true); };
  game.restartRun = function () { beginRun(true); };
  game.pause = function () {
    game.state = 'paused'; GG.UI.show('pause');
    audio.setEngine(0, false); audio.setSiren(0, 0);
  };
  game.resume = function () { game.state = 'playing'; hideAllScreens(); };
  game.quitToMenu = function () {
    game.state = 'menu'; game.running = false;
    document.getElementById('hud').classList.add('hidden');
    audio.stopMusic();
    audio.setEngine(0, false);
    audio.setSiren(0, 0);
    game.activeMission = null;
    saveNow();
    GG.UI.show('main');
  };
  game.saveNow = saveNow;
  function saveNow() { GG.writeSave(game.save); }

  game.setVolume = function (kind, v) {
    if (kind === 'sfx') { game.save.settings.sfx = v; audio.setSfxVol(v); }
    else { game.save.settings.music = v; audio.setMusicVol(v); }
    saveNow();
  };
  game.resetSave = function () {
    game.save = GG.defaultSave();
    saveNow();
    GG.UI.refreshMain(); GG.UI.refreshSettings();
    GG.UI.toast('Save data reset', 'warn');
  };

  game.buyVehicle = function (id) {
    const s = game.save, def = GG.vehicleById(id);
    if (s.unlocked.includes(id) || s.money < def.cost || s.level < def.unlockLevel) return;
    s.money -= def.cost; s.unlocked.push(id); saveNow();
    audio.ui(880); GG.UI.toast('Unlocked ' + def.name, 'mission');
    checkAchievements();
  };
  game.buyUpgrade = function (vid, key) {
    const s = game.save;
    if (!s.upgrades[vid]) s.upgrades[vid] = {};
    const lvl = s.upgrades[vid][key] || 0;
    if (lvl >= GG.MAX_UPGRADE_LEVEL) return;
    const cost = GG.upgradeCost(lvl);
    if (s.money < cost) return;
    s.money -= cost; s.upgrades[vid][key] = lvl + 1; saveNow();
    audio.ui(760);
    if (game.playerCar && game.playerCar.defId === vid) {
      const stats = GG.effectiveStats(game.playerCar.def, s.upgrades[vid]);
      game.playerCar.stats = stats; game.playerCar.phys = GG.physFromStats(stats);
      const frac = game.playerCar.hp / game.playerCar.phys.hpMax;
      game.playerCar.hp = game.playerCar.phys.hpMax * Math.min(1, frac || 1);
    }
    checkAchievements();
  };

  // ---------------------------------------------------------------------
  // Missions
  // ---------------------------------------------------------------------
  function todayKey() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
  function generateMissionPool() {
    const rng = GG.mulberry32((Math.random() * 1e9) >>> 0);
    game.availableMissions = Array.from({ length: 4 }).map(() => GG.genMission(rng));
    const key = todayKey();
    if (game.save.dailyDate !== key) {
      game.save.dailyDate = key; game.save.dailyDone = {};
      const drng = GG.mulberry32(GG.hashStr(key));
      game.dailyMissions = Array.from({ length: 3 }).map(() => GG.genMission(drng));
      game.dailyMissions.forEach(m => m.reward = Math.round(m.reward * 1.4));
      game._dailyCache = game.dailyMissions;
      saveNow();
    } else {
      if (!game._dailyCache) {
        const drng = GG.mulberry32(GG.hashStr(key));
        game._dailyCache = Array.from({ length: 3 }).map(() => GG.genMission(drng));
        game._dailyCache.forEach(m => m.reward = Math.round(m.reward * 1.4));
      }
      game.dailyMissions = game._dailyCache;
    }
  }
  game.rerollMissions = function () {
    const rng = GG.mulberry32((Math.random() * 1e9) >>> 0);
    game.availableMissions = Array.from({ length: 4 }).map(() => GG.genMission(rng));
  };

  function findMission(id) {
    return game.availableMissions.find(m => m.id === id) || game.dailyMissions.find(m => m.id === id);
  }
  game.startMissionById = function (id) {
    const m = findMission(id);
    if (!m) return;
    if (!game.running) beginRun(false);
    else { game.state = 'playing'; hideAllScreens(); }
    activateMission(m);
  };

  function randomFarPoint(minD, maxD) {
    const p = game.player;
    const ang = Math.random() * Math.PI * 2;
    const d = minD + Math.random() * (maxD - minD);
    const rt = GG.nearestRoadTile(game.world, p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, 10);
    return { x: rt.tx * GG.TILE + GG.TILE / 2, y: rt.ty * GG.TILE + GG.TILE / 2 };
  }

  function activateMission(m) {
    const inst = Object.assign({}, m, { runtime: {} });
    if (inst.type === 'survive') { inst.runtime.progress = 0; if (game.wanted.level === 0) game.wanted.add(150); }
    if (inst.type === 'reach') { inst.markerPos = randomFarPoint(500, 900); }
    if (inst.type === 'escape') { if (game.wanted.level === 0) game.wanted.add(260); }
    if (inst.type === 'checkpoints') {
      inst.runtime.idx = 0; inst.checkpoints = [];
      let last = { x: game.player.x, y: game.player.y };
      for (let i = 0; i < inst.target; i++) {
        const p = randomFarPointFrom(last, 260, 420); inst.checkpoints.push(p); last = p;
      }
      inst.markerPos = inst.checkpoints[0];
    }
    if (inst.type === 'hidden') {
      const cand = game.world.structures.filter(s => s.type === 'landmark' && !s.found);
      inst.targetStructure = cand.length ? cand[Math.floor(Math.random() * cand.length)] : game.world.structures.find(s => s.type === 'landmark');
      inst.markerPos = { x: inst.targetStructure.tx * GG.TILE + GG.TILE / 2, y: inst.targetStructure.ty * GG.TILE + GG.TILE / 2 };
    }
    if (inst.type === 'deliver') {
      inst.pickup = randomFarPoint(300, 600); inst.dropoff = randomFarPointFrom(inst.pickup, 500, 900);
      inst.runtime.phase = 'pickup'; inst.markerPos = inst.pickup;
    }
    if (inst.type === 'stunt') { inst.runtime.score = 0; inst.runtime.time = 45; }
    game.activeMission = inst;
    GG.UI.toast('Mission started: ' + m.label, 'mission');
  }
  function randomFarPointFrom(origin, minD, maxD) {
    const ang = Math.random() * Math.PI * 2;
    const d = minD + Math.random() * (maxD - minD);
    const rt = GG.nearestRoadTile(game.world, origin.x + Math.cos(ang) * d, origin.y + Math.sin(ang) * d, 10);
    return { x: rt.tx * GG.TILE + GG.TILE / 2, y: rt.ty * GG.TILE + GG.TILE / 2 };
  }

  game.missionStatusText = function () {
    const m = game.activeMission; if (!m) return '';
    if (m.type === 'survive') return Math.floor(m.runtime.progress) + '/' + m.target + 's';
    if (m.type === 'checkpoints') return 'Checkpoint ' + (m.runtime.idx + 1) + '/' + m.target;
    if (m.type === 'deliver') return m.runtime.phase === 'pickup' ? 'Pick up cargo' : 'Deliver cargo';
    if (m.type === 'stunt') return Math.floor(m.runtime.score) + '/' + m.target + ' pts';
    return '';
  };
  game.missionTimerText = function () {
    const m = game.activeMission; if (!m) return '';
    if (m.type === 'stunt') return Math.ceil(m.runtime.time) + 's left';
    return '';
  };

  function completeMission(m, fromDaily) {
    const s = game.save;
    s.money += m.reward; s.stats.lifetimeEarnings += m.reward; s.stats.missionsDone++;
    addXp(Math.round(m.reward * 0.4));
    if (fromDaily) s.dailyDone[m.id] = true;
    saveNow();
    audio.ui(920);
    GG.UI.toast(`Mission complete! +$${m.reward}`, 'mission');
    game.activeMission = null;
    checkAchievements();
  }
  function failMission() {
    GG.UI.toast('Mission failed', 'warn');
    game.activeMission = null;
  }

  function updateMission(dt) {
    const m = game.activeMission; if (!m) return;
    const p = game.player;
    const fromDaily = game.dailyMissions.includes(findMission(m.id));
    if (m.type === 'survive') {
      if (game.wanted.level > 0) m.runtime.progress += dt;
      if (m.runtime.progress >= m.target) completeMission(m, fromDaily);
    } else if (m.type === 'reach') {
      if (Math.hypot(p.x - m.markerPos.x, p.y - m.markerPos.y) < 34) completeMission(m, fromDaily);
    } else if (m.type === 'escape') {
      if (game.wanted.level === 0 && game.wanted.heat === 0) completeMission(m, fromDaily);
    } else if (m.type === 'checkpoints') {
      const cp = m.checkpoints[m.runtime.idx];
      if (Math.hypot(p.x - cp.x, p.y - cp.y) < 34) {
        m.runtime.idx++;
        if (m.runtime.idx >= m.checkpoints.length) completeMission(m, fromDaily);
        else { m.markerPos = m.checkpoints[m.runtime.idx]; audio.ui(700); }
      }
    } else if (m.type === 'hidden') {
      if (Math.hypot(p.x - m.markerPos.x, p.y - m.markerPos.y) < 46) { m.targetStructure.found = true; completeMission(m, fromDaily); }
    } else if (m.type === 'deliver') {
      if (m.runtime.phase === 'pickup' && Math.hypot(p.x - m.pickup.x, p.y - m.pickup.y) < 34) {
        m.runtime.phase = 'dropoff'; m.markerPos = m.dropoff; audio.ui(700);
      } else if (m.runtime.phase === 'dropoff' && Math.hypot(p.x - m.dropoff.x, p.y - m.dropoff.y) < 34) {
        completeMission(m, fromDaily);
      }
    } else if (m.type === 'stunt') {
      m.runtime.time -= dt;
      if (game.mode === 'drive' && game.playerCar.handbrake && Math.abs(game.playerCar.speed) > 55) {
        m.runtime.score += Math.abs(game.playerCar.steerInput) * dt * 24;
      }
      if (m.runtime.score >= m.target) completeMission(m, fromDaily);
      else if (m.runtime.time <= 0) failMission();
    }
  }

  // ---- XP / achievements -------------------------------------------------
  function xpThreshold(level) { return 220 + level * 180; }
  function addXp(n) {
    const s = game.save;
    s.xp += n;
    while (s.xp >= xpThreshold(s.level)) { s.xp -= xpThreshold(s.level); s.level++; GG.UI.toast('Level up! Lv ' + s.level, 'ach'); audio.ui(980); }
  }
  function checkAchievements() {
    const s = game.save;
    for (const a of GG.ACHIEVEMENTS) {
      if (!s.achievements[a.id] && a.check(s)) {
        s.achievements[a.id] = true; s.money += a.reward; s.stats.lifetimeEarnings += a.reward;
        GG.UI.toast(`Achievement: ${a.name} +$${a.reward}`, 'ach');
        audio.ui(1040);
      }
    }
    saveNow();
  }

  // ---------------------------------------------------------------------
  // Effects callbacks (physics -> game feel)
  // ---------------------------------------------------------------------
  function shake(amount) { game.camera.shake = Math.min(1, game.camera.shake + amount); }
  function slowmo(amount) { game.slowTimer = Math.max(game.slowTimer, amount); }

  const effects = {
    onImpact(v, impact, x, y) {
      const isPlayer = v === game.playerCar;
      GG.burst(game.particles, x, y, Math.min(18, impact * 0.06), { color: '#d9d9d9', kind: 'spark', maxSp: impact * 0.8, life: 0.35 });
      if (impact > 40) GG.burst(game.particles, x, y, 5, { color: 'rgba(120,120,120,0.7)', kind: 'smoke', size: 6, life: 1.1, drag: 0.94 });
      if (isPlayer) {
        shake(clamp(impact / 260, 0.1, 1));
        GG.UI.flashVignette(clamp(impact / 300, 0.15, 1));
        audio.crash(impact);
        if (impact > 180) slowmo(0.55);
        if (impact > 24) game.wanted.add(2.5);
      }
    },
    onVehicleHit(a, b, rel) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      GG.burst(game.particles, mx, my, 10, { color: '#ffd479', kind: 'spark', maxSp: rel, life: 0.3 });
      const playerA = a === game.playerCar, playerB = b === game.playerCar;
      if (playerA || playerB) {
        shake(clamp(rel / 280, 0.15, 1));
        audio.crash(rel);
        if (rel > 150) slowmo(0.4);
        const other = playerA ? b : a;
        if (other.def.police) game.wanted.add(28);
        else game.wanted.add(6);
      }
    },
    onWrecked(v) {
      GG.burst(game.particles, v.x, v.y, 22, { color: '#ff8a3a', kind: 'spark', maxSp: 180, life: 0.5 });
      GG.burst(game.particles, v.x, v.y, 10, { color: 'rgba(70,70,70,0.8)', kind: 'smoke', size: 8, life: 1.6, drag: 0.94 });
      game.save.stats.wrecks++;
      if (v === game.playerCar) {
        GG.UI.toast('Vehicle wrecked!', 'warn');
        exitVehicle(true);
      }
      checkAchievements();
    },
    onWaterDamage(v, dt) {
      if (Math.random() < dt * 3) GG.burst(game.particles, v.x, v.y, 2, { color: 'rgba(140,210,230,0.7)', kind: 'dot', size: 3, life: 0.6, maxSp: 30 });
      if (v === game.playerCar && Math.random() < dt) audio.splash();
    }
  };

  // ---------------------------------------------------------------------
  // Enter / exit vehicles
  // ---------------------------------------------------------------------
  function nearestEnterable() {
    const p = game.ped;
    let best = null, bestD = 46, bestList = null;
    function scan(list) {
      for (const v of list) {
        if (v.driver === 'player') continue;
        if (v.driver === 'ai-police' && !v.wrecked) continue; // can't jack a moving cruiser
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d < bestD) { bestD = d; best = v; bestList = list; }
      }
    }
    scan(game.traffic.list); scan(game.police.list); scan(game.parked);
    return best ? { v: best, list: bestList } : null;
  }

  function enterVehicle(found) {
    const { v, list } = found;
    const idx = list.indexOf(v); if (idx >= 0) list.splice(idx, 1);
    const wasStolen = v.driver !== null;
    v.driver = 'player'; v.aiState = null; v.parked = false;
    game.playerCar = v; game.mode = 'drive';
    if (wasStolen) {
      game.save.stats.thefts++;
      game.wanted.add(v.def.police ? 45 : 12);
      GG.UI.toast(v.def.police ? 'Police cruiser jacked!' : 'Vehicle stolen', 'warn');
      checkAchievements();
    }
    audio.ui(760);
  }
  function exitVehicle(forced) {
    const car = game.playerCar; if (!car) return;
    const off = car.angle + Math.PI / 2;
    game.ped.x = car.x + Math.cos(off) * (car.radius + 14);
    game.ped.y = car.y + Math.sin(off) * (car.radius + 14);
    game.ped.angle = car.angle;
    car.driver = null; car.throttleInput = 0; car.steerInput = 0; car.speed = 0; car.parked = true;
    game.parked.push(car);
    game.playerCar = null; game.mode = 'foot';
  }
  game.exitVehicle = exitVehicle;

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    audio.resume();
    if (k === 'e' && game.state === 'playing') {
      if (game.mode === 'drive') exitVehicle(false);
      else { const f = nearestEnterable(); if (f) enterVehicle(f); }
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  function readAxis(negKeys, posKeys) {
    let v = 0;
    for (const k of negKeys) if (keys.has(k)) v -= 1;
    for (const k of posKeys) if (keys.has(k)) v += 1;
    return v;
  }

  // ---------------------------------------------------------------------
  // Update / render loop
  // ---------------------------------------------------------------------
  let lastT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastT) / 1000; lastT = now;
    dt = Math.min(dt, 0.05);
    game.time += dt;

    if (game.state === 'menu') { updateMenuAmbient(dt); renderMenuAmbient(); return; }
    if (game.state === 'paused') { render(0); return; }

    // slow-mo
    if (game.slowTimer > 0) { game.slowTimer -= dt; game.timeScale = lerp(game.timeScale, 0.28, 0.3); }
    else game.timeScale = lerp(game.timeScale, 1, 0.08);
    const sdt = dt * game.timeScale;

    update(dt, sdt);
    render(sdt);
    GG.UI.updateHUD(game);
  }

  function updateMenuAmbient(dt) {
    game.menuDrift.a += dt * 0.05;
    game.camera.x = game.world.spawn.x + Math.cos(game.menuDrift.a) * 260;
    game.camera.y = game.world.spawn.y + Math.sin(game.menuDrift.a * 0.7) * 200;
  }
  function renderMenuAmbient() {
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, VW, VH);
    GG.drawWorld(ctx, game.world, game.camera, VW, VH, game.world.structures, game.time);
    ctx.fillStyle = 'rgba(11,14,20,0.45)'; ctx.fillRect(0, 0, VW, VH);
  }

  function update(dt, sdt) {
    const p = game.player;

    if (game._busted) {
      if (game.playerCar) game.playerCar.throttleInput = game.playerCar.steerInput = 0;
    } else if (game.mode === 'drive' && game.playerCar) {
      const car = game.playerCar;
      car.throttleInput = readAxis(['s', 'arrowdown'], ['w', 'arrowup']);
      car.steerInput = readAxis(['a', 'arrowleft'], ['d', 'arrowright']);
      car.handbrake = keys.has(' ');
      GG.updateVehicle(car, sdt, game.world, effects);
      if (Math.abs(car.speed) > 40 && (keys.has(' ') || Math.abs(car.steerInput) > 0.6)) {
        if (Math.random() < sdt * 20) {
          const back = car.angle + Math.PI;
          GG.burst(game.particles, car.x + Math.cos(back) * car.radius, car.y + Math.sin(back) * car.radius, 1,
            { color: 'rgba(210,210,210,0.5)', kind: 'smoke', size: 5, life: 0.6, maxSp: 18, drag: 0.9 });
        }
      }
    } else {
      const ax = readAxis(['a', 'arrowleft'], ['d', 'arrowright']);
      const ay = readAxis(['w', 'arrowup'], ['s', 'arrowdown']);
      const ped = game.ped;
      if (ax || ay) {
        const ang = Math.atan2(ay, ax);
        ped.angle = ang;
        const nx = ped.x + Math.cos(ang) * 120 * dt, ny = ped.y + Math.sin(ang) * 120 * dt;
        const solid = game.world.isSolid(Math.floor(nx / GG.TILE), Math.floor(ny / GG.TILE));
        if (!solid) { ped.x = nx; ped.y = ny; }
      }
    }

    game.traffic.update(sdt, p, game.world);
    game.police.update(sdt, p, game.world, game.wanted.level, effects);
    for (const v of game.traffic.list) GG.updateVehicle(v, sdt, game.world, effects);
    for (const v of game.police.list) GG.updateVehicle(v, sdt, game.world, effects);
    GG.resolveVehicleCollisions(
      [game.playerCar, ...game.traffic.list, ...game.police.list, ...game.parked].filter(Boolean), effects
    );
    game.particles.update(dt);
    if (game.parked.length > 24) {
      game.parked.sort((a, b) => Math.hypot(b.x - p.x, b.y - p.y) - Math.hypot(a.x - p.x, a.y - p.y));
      game.parked.length = 24;
    }

    // wanted
    const { chopperActive } = game.wanted.update(sdt, p, game.world, game.police.list);
    game.save.stats.maxWanted = Math.max(game.save.stats.maxWanted, game.wanted.level);
    game.chopperActive = chopperActive;

    // busted check (on foot, cop nearby)
    if (game.mode === 'foot' && game.wanted.level > 0) {
      for (const v of game.police.list) {
        if (v.wrecked) continue;
        if (Math.hypot(v.x - p.x, v.y - p.y) < 26) { doBusted(); break; }
      }
    }

    // gas stations / stashes / landmarks
    if (game.mode === 'drive' && game.playerCar) {
      const car = game.playerCar;
      for (const s of game.world.structures) {
        const sx = s.tx * GG.TILE + GG.TILE / 2, sy = s.ty * GG.TILE + GG.TILE / 2;
        const d = Math.hypot(car.x - sx, car.y - sy);
        if (s.type === 'gas' && d < 34 && car.hp < car.phys.hpMax) {
          car.hp = Math.min(car.phys.hpMax, car.hp + 55 * dt);
        } else if (s.type === 'stash' && s.active && d < 30) {
          s.active = false; s.cooldown = 55;
          const amt = Math.round(150 + Math.random() * 260);
          game.save.money += amt; game.save.stats.lifetimeEarnings += amt;
          GG.UI.toast('Found a stash! +$' + amt, 'mission'); audio.ui(900);
        } else if (s.type === 'landmark' && !s.found && d < 60) {
          s.found = true; game.save.money += 50; addXp(20);
          GG.UI.toast('Discovered ' + s.name, 'ach'); audio.ui(840);
        }
      }
    }
    for (const s of game.world.structures) {
      if (s.type === 'stash' && !s.active) { s.cooldown -= dt; if (s.cooldown <= 0) s.active = true; }
    }

    updateMission(sdt);

    // interact prompt
    if (game.mode === 'foot') {
      const f = nearestEnterable();
      GG.UI.setInteract(f ? (f.v.def.police ? 'Steal Cruiser' : 'Enter Vehicle') : null);
    } else {
      GG.UI.setInteract('Exit Vehicle');
    }

    // camera follow
    const lookAhead = game.mode === 'drive' && game.playerCar ? 46 : 0;
    const targetX = p.x + Math.cos(p.angle) * (p.speed ? Math.sign(p.speed) : 0) * Math.min(lookAhead, Math.abs(p.speed || 0) * 0.15);
    const targetY = p.y + Math.sin(p.angle) * (p.speed ? Math.sign(p.speed) : 0) * Math.min(lookAhead, Math.abs(p.speed || 0) * 0.15);
    game.camera.x = lerp(game.camera.x, targetX, 0.09);
    game.camera.y = lerp(game.camera.y, targetY, 0.09);
    game.camera.shake = Math.max(0, game.camera.shake - dt * 1.8);

    // audio
    const speedFrac = game.mode === 'drive' && game.playerCar ? Math.abs(game.playerCar.speed) / game.playerCar.phys.top : 0;
    audio.setEngine(speedFrac, game.mode === 'drive');
    audio.setSiren(game.wanted.level > 0 ? clamp(game.police.countActive() / 4, 0, 1) : 0, dt);
    audio.tickMusic(dt, clamp(game.wanted.level / 10, 0, 1));

    // autosave
    game._autosave = (game._autosave || 0) + dt;
    if (game._autosave > 8) { game._autosave = 0; saveNow(); }
    game.save.stats.bestSurvival = Math.max(game.save.stats.bestSurvival, (performance.now() - game.runStart) / 1000);
  }

  function doBusted() {
    if (game._busted) return;
    game._busted = true;
    GG.UI.setBusted(true);
    game.save.stats.busts++;
    game.save.money = Math.round(game.save.money * 0.85);
    audio.ui(220);
    setTimeout(() => {
      game.wanted.reset();
      const sp = game.world.spawn;
      game.ped.x = sp.x; game.ped.y = sp.y;
      GG.UI.setBusted(false);
      game._busted = false;
    }, 1800);
  }

  function render(sdt) {
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, VW, VH);
    const shakeX = game.camera.shake ? (Math.random() - 0.5) * game.camera.shake * 18 : 0;
    const shakeY = game.camera.shake ? (Math.random() - 0.5) * game.camera.shake * 18 : 0;
    const cam = { x: game.camera.x - shakeX, y: game.camera.y - shakeY };

    GG.drawWorld(ctx, game.world, cam, VW, VH, game.world.structures, game.time);

    const allVehicles = [...game.traffic.list, ...game.police.list, ...game.parked];
    for (const v of allVehicles) GG.drawVehicle(ctx, v, cam, VW, VH, false, game.time);
    if (game.playerCar) GG.drawVehicle(ctx, game.playerCar, cam, VW, VH, true, game.time);
    if (game.mode === 'foot') {
      const c = GG.CHARACTERS.find(c => c.id === game.save.character) || GG.CHARACTERS[0];
      GG.drawPedestrian(ctx, game.ped, cam, VW, VH, c.color);
    }
    GG.drawParticles(ctx, game.particles.all, cam, VW, VH);

    if (game.chopperActive) {
      const originX = VW / 2 - cam.x, originY = VH / 2 - cam.y;
      const p = game.player;
      const hx = p.x + Math.cos(game.time * 1.6) * 90, hy = p.y + Math.sin(game.time * 1.6) * 90 - 40;
      ctx.save(); ctx.translate(hx + originX, hy + originY);
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(0, 0, 14, 6, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-20, -6); ctx.lineTo(20, -6 + Math.sin(game.time * 40) * 2); ctx.stroke();
      ctx.restore();
    }

    if (game.activeMission && game.activeMission.markerPos && game.state === 'playing') {
      const originX = VW / 2 - cam.x, originY = VH / 2 - cam.y;
      const mx = game.activeMission.markerPos.x + originX, my = game.activeMission.markerPos.y + originY;
      ctx.save(); ctx.translate(mx, my); ctx.translate(0, Math.sin(game.time * 3) * 5 - 26);
      ctx.fillStyle = '#ffd23a';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(8, -14); ctx.lineTo(-8, -14); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    if (game.state === 'playing') {
      GG.drawMinimap(mmCtx, game.minimapBitmap, game.world, game.player, game.police.list, game.world.structures,
        game.activeMission ? game.activeMission.markerPos : null, mmCanvas.width);
      const p = game.player;
      const speedKmh = Math.abs(p.speed || 0) * 0.9;
      const frac = game.mode === 'drive' && game.playerCar ? Math.abs(p.speed) / p.phys.top : 0;
      GG.drawSpeedGauge(speedCtx, speedCanvas.width, frac, speedKmh, 1);
    }
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function boot() {
    audio.setSfxVol(game.save.settings.sfx);
    audio.setMusicVol(game.save.settings.music);
    setupMenuWorld();
    generateMissionPool();
    GG.UI.init(game);
    GG.UI.refreshMain();
    requestAnimationFrame(frame);
  }

  function snapshot() {
    return { save: game.save };
  }
  if (window.claude && window.claude.hot) {
    window.claude.hot.snapshot(snapshot);
    const seed = window.claude.hot.data;
    if (seed && seed.save) { try { GG.writeSave(Object.assign(GG.defaultSave(), seed.save)); } catch (e) {} }
    window.claude.hot.ready ? window.claude.hot.ready(boot) : boot();
  } else {
    boot();
  }

})(window.GG = window.GG || {});
