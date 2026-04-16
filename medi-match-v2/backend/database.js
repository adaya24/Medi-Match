require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function getOne(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

async function getAll(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

async function run(sql, params = []) {
  return await query(sql, params);
}

async function initDb() {
  // ── Users ──────────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    full_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Hospitals ───────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS hospitals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    total_icu INTEGER DEFAULT 20,
    available_icu INTEGER DEFAULT 20,
    total_ventilator INTEGER DEFAULT 10,
    available_ventilator INTEGER DEFAULT 10,
    total_isolation INTEGER DEFAULT 30,
    available_isolation INTEGER DEFAULT 30,
    total_general INTEGER DEFAULT 100,
    available_general INTEGER DEFAULT 100,
    total_beds INTEGER DEFAULT 160,
    available_beds INTEGER DEFAULT 160,
    status TEXT DEFAULT 'operational',
    oxygen_level INTEGER DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Rescue Teams ────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS rescue_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    status TEXT DEFAULT 'available',
    current_victim_id TEXT,
    capacity INTEGER DEFAULT 4,
    current_load INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Victims ─────────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS victims (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    severity TEXT DEFAULT 'moderate',
    severity_score INTEGER DEFAULT 50,
    status TEXT DEFAULT 'waiting',
    assigned_team_id TEXT,
    assigned_hospital_id TEXT,
    oxygen_level INTEGER,
    heart_rate INTEGER,
    respiratory_rate INTEGER,
    temperature REAL,
    consciousness TEXT DEFAULT 'conscious',
    triage_category TEXT DEFAULT 'yellow',
    reported_at TIMESTAMPTZ DEFAULT NOW(),
    admitted_at TIMESTAMPTZ
  )`);

  // ── Incidents ───────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    description TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    severity TEXT DEFAULT 'moderate',
    status TEXT DEFAULT 'active',
    victim_count INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Supplies ─────────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS supplies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    current_stock INTEGER DEFAULT 0,
    min_threshold INTEGER DEFAULT 10,
    max_capacity INTEGER DEFAULT 100,
    unit TEXT DEFAULT 'units',
    weight_per_unit REAL DEFAULT 1.0,
    utility_value INTEGER DEFAULT 50,
    hospital_id TEXT,
    last_updated TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Bed Admissions ───────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS bed_admissions (
    id TEXT PRIMARY KEY,
    victim_id TEXT NOT NULL,
    hospital_id TEXT NOT NULL,
    bed_type TEXT NOT NULL,
    admitted_at TIMESTAMPTZ DEFAULT NOW(),
    discharged_at TIMESTAMPTZ,
    status TEXT DEFAULT 'admitted'
  )`);

  // ── Supply Deliveries ────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS supply_deliveries (
    id TEXT PRIMARY KEY,
    hospital_id TEXT,
    items_json TEXT,
    total_utility INTEGER DEFAULT 0,
    route_json TEXT,
    total_dist_km REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Medicine Orders ──────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS medicine_orders (
    id TEXT PRIMARY KEY,
    supply_id TEXT NOT NULL,
    hospital_id TEXT,
    quantity INTEGER NOT NULL,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'pending',
    ordered_by TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    fulfilled_at TIMESTAMPTZ
  )`);

  // ── Consumption Log ──────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS consumption_log (
    id TEXT PRIMARY KEY,
    supply_id TEXT NOT NULL,
    hospital_id TEXT,
    quantity_used INTEGER NOT NULL,
    reason TEXT,
    logged_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── Seed data only if empty ─────────────────────────────────────────────────
  const { rows } = await query('SELECT COUNT(*) AS cnt FROM users');
  if (Number(rows[0].cnt) === 0) await seedData();

  console.log('✅ Neon PostgreSQL initialized');
}

async function seedData() {
  const bcrypt = require('bcryptjs');
  const adminHash = await bcrypt.hash('admin123', 10);
  const userHash  = await bcrypt.hash('user123', 10);

  await run(
    `INSERT INTO users (id, username, password_hash, role, full_name) VALUES
    ('U001','admin','${adminHash}','admin','System Administrator'),
    ('U002','user1','${userHash}','user','Field Operator')
    ON CONFLICT (username) DO NOTHING`
  );

  await run(`INSERT INTO hospitals (id,name,lat,lng,total_icu,available_icu,total_ventilator,available_ventilator,
    total_isolation,available_isolation,total_general,available_general,total_beds,available_beds,oxygen_level,status)
    VALUES
    ('H001','AIIMS Delhi',28.5672,77.2100,50,12,20,5,80,30,300,80,450,127,45,'operational'),
    ('H002','Safdarjung Hospital',28.5699,77.2062,40,28,15,11,60,45,250,180,365,264,78,'operational'),
    ('H003','RML Hospital',28.6271,77.2084,30,3,10,2,50,8,200,22,290,35,20,'critical'),
    ('H004','GTB Hospital',28.6726,77.3092,35,22,12,9,70,55,280,210,397,296,85,'operational'),
    ('H005','Lok Nayak Hospital',28.6390,77.2285,45,18,18,8,75,40,320,95,458,161,62,'operational')
    ON CONFLICT (id) DO NOTHING`);

  await run(`INSERT INTO rescue_teams (id,name,lat,lng,status,capacity,current_load) VALUES
    ('T001','Alpha Team',28.6139,77.2090,'available',4,0),
    ('T002','Bravo Team',28.6350,77.2240,'en-route',4,2),
    ('T003','Charlie Team',28.5850,77.2310,'available',6,0),
    ('T004','Delta Team',28.6480,77.1890,'at-hospital',4,1),
    ('T005','Echo Team',28.5920,77.1750,'available',4,0)
    ON CONFLICT (id) DO NOTHING`);

  await run(`INSERT INTO victims (id,name,lat,lng,severity,severity_score,status,assigned_team_id,assigned_hospital_id,
    oxygen_level,heart_rate,respiratory_rate,temperature,consciousness,triage_category) VALUES
    ('V001','Rajesh Kumar',28.6200,77.2150,'critical',92,'admitted','T002','H001',82,130,32,39.8,'confused','red'),
    ('V002','Priya Sharma',28.6080,77.2380,'moderate',58,'waiting',NULL,NULL,94,95,22,38.2,'conscious','yellow'),
    ('V003','Amit Singh',28.6450,77.1980,'critical',87,'in-transit','T004','H002',85,145,35,40.1,'unconscious','red'),
    ('V004','Sunita Devi',28.5980,77.2250,'mild',30,'waiting',NULL,NULL,97,80,18,37.5,'conscious','green'),
    ('V005','Vikram Patel',28.6310,77.2450,'moderate',65,'waiting',NULL,NULL,91,108,26,38.9,'conscious','yellow'),
    ('V006','Kavita Rao',28.6020,77.1820,'critical',95,'waiting',NULL,NULL,78,155,38,40.5,'unconscious','red')
    ON CONFLICT (id) DO NOTHING`);

  await run(`INSERT INTO supplies (id,name,category,current_stock,min_threshold,max_capacity,unit,weight_per_unit,utility_value,hospital_id) VALUES
    ('S001','Morphine Injections','analgesic',45,80,300,'vials',0.05,98,'H001'),
    ('S002','Adrenaline (Epinephrine)','cardiac_drugs',18,30,150,'vials',0.05,99,'H001'),
    ('S003','Antibiotics (Amoxicillin)','antibiotic',180,200,800,'capsules',0.01,85,'H002'),
    ('S004','IV Saline 500ml','iv_fluids',95,150,600,'bags',0.52,88,'H001'),
    ('S005','Oral Rehydration Salts','oral_fluids',320,400,2000,'sachets',0.02,72,'H003'),
    ('S006','Paracetamol Tablets','analgesic',850,1000,5000,'tablets',0.005,65,'H002'),
    ('S007','Surgical Gloves','consumable',220,300,2000,'pairs',0.03,70,'H004'),
    ('S008','Sterile Syringes 5ml','consumable',380,500,3000,'units',0.01,75,'H003'),
    ('S009','Activated Charcoal','antidote',12,20,100,'sachets',0.05,82,'H001'),
    ('S010','Insulin (Rapid Acting)','diabetes',28,40,200,'vials',0.05,95,'H005'),
    ('S011','Atropine Injections','cardiac_drugs',8,15,80,'vials',0.05,97,'H003'),
    ('S012','Blood Glucose Test Strips','diagnostic',150,200,1000,'strips',0.002,68,'H004'),
    ('S013','Oral Antibiotics (Ciprofloxacin)','antibiotic',90,120,500,'tablets',0.006,83,'H002'),
    ('S014','Anti-diarrheal (ORS packs)','oral_fluids',410,500,2000,'packs',0.03,71,'H005'),
    ('S015','Wound Dressing Kits','wound_care',65,100,400,'kits',0.08,78,'H004')
    ON CONFLICT (id) DO NOTHING`);

  await run(`INSERT INTO incidents (id,type,description,lat,lng,severity,status,victim_count) VALUES
    ('I001','epidemic','Cholera outbreak in densely populated area',28.6200,77.2150,'critical','active',45),
    ('I002','accident','Multi-vehicle collision on highway',28.6450,77.1980,'high','active',12),
    ('I003','fire','Industrial fire with toxic smoke',28.5980,77.2250,'moderate','contained',8)
    ON CONFLICT (id) DO NOTHING`);

  console.log('✅ Seed data inserted');
}

module.exports = { pool, query, getOne, getAll, run, initDb };
