// ============================================================================
// GRIDLOCK GETAWAY — data.js
// Data-driven content: seeded RNG, vehicle database generator, characters,
// mission templates, achievements, upgrade tables. No external assets.
// ============================================================================
(function (GG) {
  'use strict';

  // ---- Seeded RNG (mulberry32) ------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return (h ^ (h >>> 16)) >>> 0;
  }
  GG.mulberry32 = mulberry32;
  GG.hashStr = hashStr;

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function range(rng, lo, hi) { return lo + rng() * (hi - lo); }

  // ---- Vehicle database ----------------------------------------------------
  // Each vehicle: id, name, category, tier, colors, and normalized 0-100 stats:
  // accel, top, handling, weight, durability, brake, offroad.
  const VEHICLES = [];

  const CIV_PREFIX = ["Falcon","Comet","Marlin","Sable","Vantage","Alder","Birch",
    "Halcyon","Sundial","Meridian","Orchid","Pelican","Rustler","Wayfarer",
    "Crestline","Harbor","Lumen","Redwood","Sparrow","Tumbleweed"];
  const CIV_MODEL = ["Sedan","Coupe","Wagon","Hatch","Runabout"];
  const CIV_COLORS = ["#c9432b","#3b6fa8","#d8b23a","#5a8f5c","#8a8f99","#b5622f",
    "#4b4f5c","#a4472f","#6a8caf","#c7973a","#517a52","#7d818c","#9c3d55","#39707a",
    "#a67a3a","#5f6e8f","#8a4f9c","#3f8f7a","#c25b3c","#54607a"];
  for (let i = 0; i < 20; i++) {
    const rng = mulberry32(hashStr('civ' + i));
    const prefix = CIV_PREFIX[i];
    const model = CIV_MODEL[i % CIV_MODEL.length];
    VEHICLES.push({
      id: 'civ_' + i,
      name: prefix + ' ' + model,
      category: 'civilian',
      tier: 0,
      color: CIV_COLORS[i],
      cost: Math.round(600 + i * 180 + range(rng, 0, 150)),
      unlockLevel: Math.max(1, Math.round(i / 3)),
      stats: {
        accel: Math.round(range(rng, 28, 58)),
        top: Math.round(range(rng, 38, 66)),
        handling: Math.round(range(rng, 38, 66)),
        weight: Math.round(range(rng, 28, 58)),
        durability: Math.round(range(rng, 28, 52)),
        brake: Math.round(range(rng, 38, 62)),
        offroad: Math.round(range(rng, 12, 30))
      }
    });
  }
  // starter car is always cheap & owned
  VEHICLES[0].cost = 0;
  VEHICLES[0].unlockLevel = 1;
  VEHICLES[0].starter = true;

  const PUR_PREFIX = ["Sentinel","Warden","Vanguard","Ironclad","Bastion",
    "Marshal","Aegis","Talon","Ranger","Constable"];
  const PUR_COLORS = ["#274b7a","#2b5a8c","#1f3f66","#345f8f","#2a4d78",
    "#3a6699","#22415f","#3d6ba0","#264768","#2f5a86"];
  for (let i = 0; i < 10; i++) {
    const rng = mulberry32(hashStr('pur' + i));
    const t = i / 9;
    VEHICLES.push({
      id: 'pur_' + i,
      name: PUR_PREFIX[i] + (i < 5 ? ' Cruiser' : ' Interceptor'),
      category: 'pursuit',
      tier: Math.floor(t * 4), // spawn tier 0-4 used by police AI escalation
      color: PUR_COLORS[i],
      cost: Math.round(2200 + i * 650),
      unlockLevel: 3 + i,
      police: true,
      stats: {
        accel: Math.round(52 + t * 26 + range(rng, -4, 4)),
        top: Math.round(60 + t * 24 + range(rng, -4, 4)),
        handling: Math.round(58 + t * 14 + range(rng, -4, 4)),
        weight: Math.round(46 + t * 22 + range(rng, -4, 4)),
        durability: Math.round(46 + t * 26 + range(rng, -4, 4)),
        brake: Math.round(55 + t * 16 + range(rng, -4, 4)),
        offroad: Math.round(20 + t * 16 + range(rng, -4, 4))
      }
    });
  }

  const OFF_PREFIX = ["Timberwolf","Boulder","Outrider","Prairie","Canyon"];
  const OFF_COLORS = ["#4c5a3a","#5c4a34","#3f5c4a","#6b5a3a","#4a5c5c"];
  for (let i = 0; i < 5; i++) {
    const rng = mulberry32(hashStr('off' + i));
    VEHICLES.push({
      id: 'off_' + i,
      name: OFF_PREFIX[i] + ' Trekker',
      category: 'offroad',
      tier: 0,
      color: OFF_COLORS[i],
      cost: Math.round(3200 + i * 900),
      unlockLevel: 4 + i,
      stats: {
        accel: Math.round(range(rng, 38, 58)),
        top: Math.round(range(rng, 42, 62)),
        handling: Math.round(range(rng, 34, 52)),
        weight: Math.round(range(rng, 55, 74)),
        durability: Math.round(range(rng, 55, 76)),
        brake: Math.round(range(rng, 38, 58)),
        offroad: Math.round(range(rng, 72, 96))
      }
    });
  }

  VEHICLES.push({
    id: 'spec_wraith', name: 'Wraith', category: 'special', tier: 0, color: '#c94b8a',
    cost: 5200, unlockLevel: 6, narrow: true,
    stats: { accel: 78, top: 74, handling: 92, weight: 14, durability: 24, brake: 70, offroad: 30 }
  });
  VEHICLES.push({
    id: 'spec_juggernaut', name: 'Juggernaut', category: 'special', tier: 0, color: '#7a5230',
    cost: 7600, unlockLevel: 8, smashesObstacles: true,
    stats: { accel: 30, top: 44, handling: 26, weight: 96, durability: 92, brake: 34, offroad: 60 }
  });
  VEHICLES.push({
    id: 'spec_ironsides', name: 'Ironsides', category: 'special', tier: 0, color: '#5a5a5a',
    cost: 8800, unlockLevel: 9,
    stats: { accel: 34, top: 40, handling: 30, weight: 88, durability: 100, brake: 40, offroad: 40 }
  });
  VEHICLES.push({
    id: 'spec_comet', name: 'Comet Racer', category: 'special', tier: 0, color: '#e0c23a',
    cost: 9600, unlockLevel: 10,
    stats: { accel: 90, top: 96, handling: 68, weight: 34, durability: 30, brake: 66, offroad: 20 }
  });
  VEHICLES.push({
    id: 'spec_skyhopper', name: 'Skyhopper', category: 'special', tier: 0, color: '#3aa0a0',
    cost: 6400, unlockLevel: 7,
    stats: { accel: 62, top: 58, handling: 70, weight: 40, durability: 50, brake: 58, offroad: 88 }
  });

  const WAT_PREFIX = ["Riptide","Driftwood","Marina","Current","Tidebreaker"];
  const WAT_COLORS = ["#2a6f7a","#2f5f8a","#3a7a6a","#25607a","#2f708f"];
  for (let i = 0; i < 5; i++) {
    const rng = mulberry32(hashStr('wat' + i));
    VEHICLES.push({
      id: 'wat_' + i,
      name: WAT_PREFIX[i] + (i % 2 === 0 ? ' Skiff' : ' Runner'),
      category: 'water',
      tier: 0,
      color: WAT_COLORS[i],
      cost: Math.round(2600 + i * 700),
      unlockLevel: 5 + i,
      waterOnly: true,
      stats: {
        accel: Math.round(range(rng, 40, 60)),
        top: Math.round(range(rng, 50, 74)),
        handling: Math.round(range(rng, 40, 60)),
        weight: Math.round(range(rng, 30, 50)),
        durability: Math.round(range(rng, 30, 50)),
        brake: Math.round(range(rng, 40, 60)),
        offroad: Math.round(range(rng, 60, 90)) // = water handling
      }
    });
  }

  GG.VEHICLES = VEHICLES;
  GG.vehicleById = (id) => VEHICLES.find(v => v.id === id);

  // ---- Characters (cosmetic, on-foot) --------------------------------------
  GG.CHARACTERS = [
    { id: 'vega', name: 'Vega', color: '#e0475b', blurb: 'Never signals a turn.' },
    { id: 'bram', name: 'Bram', color: '#3a8fd8', blurb: 'Talks to the radio.' },
    { id: 'juno', name: 'Juno', color: '#e0b23a', blurb: 'Allergic to parking lines.' },
    { id: 'coz', name: 'Coz', color: '#4ac97a', blurb: 'Counts crashes as wins.' }
  ];

  // ---- Upgrades --------------------------------------------------------
  GG.UPGRADE_KEYS = ['engine', 'tires', 'brakes', 'armor', 'handling', 'chassis'];
  GG.UPGRADE_META = {
    engine:   { label: 'Engine',   stat: 'accel',      perLevel: 6 },
    tires:    { label: 'Tires',    stat: 'top',         perLevel: 5 },
    brakes:   { label: 'Brakes',   stat: 'brake',       perLevel: 7 },
    armor:    { label: 'Armor',    stat: 'durability',  perLevel: 8 },
    handling: { label: 'Handling', stat: 'handling',    perLevel: 6 },
    chassis:  { label: 'Chassis',  stat: 'offroad',     perLevel: 7 }
  };
  GG.MAX_UPGRADE_LEVEL = 5;
  GG.upgradeCost = (level) => Math.round(300 * Math.pow(1.55, level));

  // ---- Mission templates -------------------------------------------------
  GG.MISSION_TYPES = [
    { type: 'survive', label: 'Stay Alive', desc: (m) => `Survive ${m.target}s with a wanted level active.`, reward: (m) => 400 + m.target * 8 },
    { type: 'reach', label: 'Ghost Run', desc: () => `Reach the marked location.`, reward: () => 500 },
    { type: 'escape', label: 'Cool Off', desc: () => `Drop your wanted level to zero.`, reward: () => 550 },
    { type: 'checkpoints', label: 'Circuit Run', desc: (m) => `Hit all ${m.target} checkpoints in order.`, reward: (m) => 300 + m.target * 120 },
    { type: 'hidden', label: 'Backroad Secret', desc: () => `Find the hidden landmark.`, reward: () => 650 },
    { type: 'deliver', label: 'Cargo Run', desc: () => `Pick up the package and deliver it.`, reward: () => 700 },
    { type: 'stunt', label: 'Tire Show', desc: (m) => `Chain ${m.target} drift points before time runs out.`, reward: (m) => 350 + m.target * 4 }
  ];

  // ---- Achievements -------------------------------------------------------
  GG.ACHIEVEMENTS = [
    { id: 'first_wreck', name: 'First Contact', desc: 'Wreck a vehicle.', check: (s) => s.stats.wrecks >= 1, reward: 100 },
    { id: 'joyrider', name: 'Joyrider', desc: 'Steal 5 vehicles.', check: (s) => s.stats.thefts >= 5, reward: 300 },
    { id: 'most_wanted', name: 'Most Wanted', desc: 'Reach wanted level 10.', check: (s) => s.stats.maxWanted >= 10, reward: 1000 },
    { id: 'money_bags', name: 'Money Bags', desc: 'Earn $10,000 lifetime.', check: (s) => s.stats.lifetimeEarnings >= 10000, reward: 500 },
    { id: 'survivor', name: 'Survivor', desc: 'Survive 3 minutes in one run.', check: (s) => s.stats.bestSurvival >= 180, reward: 400 },
    { id: 'collector', name: 'Collector', desc: 'Unlock 10 vehicles.', check: (s) => s.unlocked.length >= 10, reward: 600 },
    { id: 'fully_loaded', name: 'Fully Loaded', desc: 'Max out every upgrade on one vehicle.', check: (s) => Object.values(s.upgrades || {}).some(u => GG.UPGRADE_KEYS.every(k => (u[k] || 0) >= GG.MAX_UPGRADE_LEVEL)), reward: 800 },
    { id: 'daily_grind', name: 'Daily Grind', desc: 'Complete 5 missions.', check: (s) => s.stats.missionsDone >= 5, reward: 350 }
  ];

  // ---- Wanted tiers ---------------------------------------------------
  GG.WANTED_TIERS = [
    { level: 1, name: 'Patrol',         spawnRate: 5.5, maxUnits: 2, tier: 0, speedMul: 0.92 },
    { level: 2, name: 'Pursuit',        spawnRate: 4.6, maxUnits: 3, tier: 0, speedMul: 0.96 },
    { level: 3, name: 'Roadblocks',     spawnRate: 4.0, maxUnits: 4, tier: 1, speedMul: 0.99 },
    { level: 4, name: 'Heavy Units',    spawnRate: 3.5, maxUnits: 5, tier: 1, speedMul: 1.02 },
    { level: 5, name: 'Interceptors',   spawnRate: 3.1, maxUnits: 6, tier: 2, speedMul: 1.05 },
    { level: 6, name: 'Special Ops',    spawnRate: 2.7, maxUnits: 7, tier: 2, speedMul: 1.08 },
    { level: 7, name: 'Task Force',     spawnRate: 2.4, maxUnits: 8, tier: 3, speedMul: 1.11 },
    { level: 8, name: 'Air Support',    spawnRate: 2.1, maxUnits: 9, tier: 3, speedMul: 1.14, chopper: true },
    { level: 9, name: 'Armored Convoy', spawnRate: 1.8, maxUnits: 10, tier: 4, speedMul: 1.17, chopper: true },
    { level: 10, name: 'Lockdown',      spawnRate: 1.5, maxUnits: 12, tier: 4, speedMul: 1.22, chopper: true }
  ];

})(window.GG = window.GG || {});
