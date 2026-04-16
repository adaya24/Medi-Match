const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getOne, getAll, run } = require('../database');
const { quickSort, calculateSeverityScore, getTriageCategory, knapsack, greedyTSP, dijkstra } = require('../algorithms');
const { authMiddleware, adminOnly } = require('./auth');

// ── TRIAGE ────────────────────────────────────────────────────────────────────

router.get('/triage', authMiddleware, async (req, res) => {
  try {
    const victims = await getAll(`
      SELECT v.*, t.name AS team_name, h.name AS hospital_name FROM victims v
      LEFT JOIN rescue_teams t ON v.assigned_team_id = t.id
      LEFT JOIN hospitals h ON v.assigned_hospital_id = h.id`);
    const sorted = quickSort(victims, 'severity_score');
    res.json({ success: true, data: sorted });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/triage/:id/vitals', authMiddleware, adminOnly, async (req, res) => {
  try {
    const vitals   = req.body;
    const score    = calculateSeverityScore(vitals);
    const category = getTriageCategory(score);
    const severity = score >= 75 ? 'critical' : score >= 45 ? 'moderate' : 'mild';
    await run(
      `UPDATE victims SET oxygen_level=$1,heart_rate=$2,respiratory_rate=$3,temperature=$4,
       consciousness=$5,severity_score=$6,triage_category=$7,severity=$8 WHERE id=$9`,
      [vitals.oxygen_level, vitals.heart_rate, vitals.respiratory_rate, vitals.temperature,
       vitals.consciousness, score, category, severity, req.params.id]
    );
    const victim = await getOne('SELECT * FROM victims WHERE id=$1', [req.params.id]);
    if (req.app.get('io')) req.app.get('io').emit('vitals_updated', victim);
    res.json({ success: true, data: victim });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── SUPPLY CATALOG (medicines & consumables only) ─────────────────────────────

router.get('/supplies', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT s.*, h.name AS hospital_name FROM supplies s
      LEFT JOIN hospitals h ON s.hospital_id = h.id
      ORDER BY s.utility_value DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/supplies/summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT category,
             COUNT(*) AS item_count,
             SUM(current_stock) AS total_stock,
             SUM(min_threshold) AS total_threshold,
             SUM(CASE WHEN current_stock < min_threshold THEN 1 ELSE 0 END) AS low_count
      FROM supplies GROUP BY category ORDER BY low_count DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/supplies/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { current_stock } = req.body;
    await run("UPDATE supplies SET current_stock=$1, last_updated=NOW() WHERE id=$2", [current_stock, req.params.id]);
    const supply = await getOne(`SELECT s.*, h.name AS hospital_name FROM supplies s LEFT JOIN hospitals h ON s.hospital_id=h.id WHERE s.id=$1`, [req.params.id]);
    if (req.app.get('io')) req.app.get('io').emit('supply_updated', supply);
    res.json({ success: true, data: supply });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── MEDICINE ORDERS ───────────────────────────────────────────────────────────

router.get('/supplies/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT o.*, s.name AS supply_name, s.unit, s.category, h.name AS hospital_name
      FROM medicine_orders o
      LEFT JOIN supplies s ON o.supply_id = s.id
      LEFT JOIN hospitals h ON o.hospital_id = h.id
      ORDER BY CASE o.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, o.created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/supplies/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { supply_id, hospital_id, quantity, priority = 'normal', notes } = req.body;
    if (!supply_id || !quantity) return res.status(400).json({ success: false, error: 'supply_id and quantity required' });
    const id = 'ORD-' + uuidv4().slice(0, 8).toUpperCase();
    await run(
      'INSERT INTO medicine_orders (id,supply_id,hospital_id,quantity,priority,status,ordered_by,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, supply_id, hospital_id || null, quantity, priority, 'pending', req.user?.username || 'admin', notes || null]
    );
    const order = await getOne(`
      SELECT o.*, s.name AS supply_name, s.unit, h.name AS hospital_name
      FROM medicine_orders o
      LEFT JOIN supplies s ON o.supply_id = s.id
      LEFT JOIN hospitals h ON o.hospital_id = h.id WHERE o.id=$1`, [id]);
    if (req.app.get('io')) req.app.get('io').emit('order_created', order);
    res.status(201).json({ success: true, data: order });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/supplies/orders/:id/fulfil', authMiddleware, adminOnly, async (req, res) => {
  try {
    const order  = await getOne('SELECT * FROM medicine_orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    const supply = await getOne('SELECT * FROM supplies WHERE id=$1', [order.supply_id]);
    if (Number(supply.current_stock) < Number(order.quantity))
      return res.status(400).json({ success: false, error: `Insufficient stock: ${supply.current_stock} ${supply.unit} available` });

    await run("UPDATE supplies SET current_stock=current_stock-$1, last_updated=NOW() WHERE id=$2", [order.quantity, order.supply_id]);
    await run("UPDATE medicine_orders SET status='fulfilled', fulfilled_at=NOW() WHERE id=$1", [req.params.id]);
    await run('INSERT INTO consumption_log (id,supply_id,hospital_id,quantity_used,reason,logged_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), order.supply_id, order.hospital_id, order.quantity, `Order ${order.id} fulfilled`, req.user?.username || 'admin']);

    const upd = await getOne(`SELECT s.*, h.name AS hospital_name FROM supplies s LEFT JOIN hospitals h ON s.hospital_id=h.id WHERE s.id=$1`, [order.supply_id]);
    if (req.app.get('io')) { req.app.get('io').emit('supply_updated', upd); req.app.get('io').emit('order_fulfilled', { orderId: req.params.id, supply: upd }); }
    res.json({ success: true, data: { supply: upd } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/supplies/orders/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
  try {
    await run("UPDATE medicine_orders SET status='cancelled' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── CONSUMPTION LOG ───────────────────────────────────────────────────────────

router.get('/supplies/consumption', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT c.*, s.name AS supply_name, s.unit, s.category, h.name AS hospital_name
      FROM consumption_log c LEFT JOIN supplies s ON c.supply_id = s.id
      LEFT JOIN hospitals h ON c.hospital_id = h.id
      ORDER BY c.created_at DESC LIMIT 50`);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/supplies/consume', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { supply_id, hospital_id, quantity_used, reason } = req.body;
    if (!supply_id || !quantity_used) return res.status(400).json({ success: false, error: 'supply_id and quantity_used required' });
    const supply = await getOne('SELECT * FROM supplies WHERE id=$1', [supply_id]);
    if (!supply) return res.status(404).json({ success: false, error: 'Supply not found' });
    const newStock = Math.max(0, Number(supply.current_stock) - Number(quantity_used));
    await run("UPDATE supplies SET current_stock=$1, last_updated=NOW() WHERE id=$2", [newStock, supply_id]);
    await run('INSERT INTO consumption_log (id,supply_id,hospital_id,quantity_used,reason,logged_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), supply_id, hospital_id || null, quantity_used, reason || 'Manual entry', req.user?.username || 'admin']);
    const upd = await getOne(`SELECT s.*, h.name AS hospital_name FROM supplies s LEFT JOIN hospitals h ON s.hospital_id=h.id WHERE s.id=$1`, [supply_id]);
    if (req.app.get('io')) req.app.get('io').emit('supply_updated', upd);
    res.json({ success: true, data: upd });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── TRUCK LOADING — Knapsack + Greedy TSP + Dijkstra ─────────────────────────

router.post('/supplies/load-truck', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { max_weight_kg = 50, hospital_ids = [], priority_categories = [] } = req.body;
    let items = await getAll("SELECT * FROM supplies WHERE current_stock > 0 ORDER BY utility_value DESC");
    if (priority_categories.length) {
      items = items.map(i => ({
        ...i,
        utility_value: priority_categories.includes(i.category)
          ? Math.min(100, Number(i.utility_value) + 15)
          : i.utility_value
      }));
    }
    const { totalUtility, selected } = knapsack(items, max_weight_kg);

    const depot = { id: 'DEPOT', name: 'Central Medical Store', lat: 28.6139, lng: 77.2090 };
    const hospitals = hospital_ids.length
      ? await getAll(`SELECT id,name,lat,lng FROM hospitals WHERE id = ANY($1::text[])`, [hospital_ids])
      : await getAll('SELECT id,name,lat,lng FROM hospitals ORDER BY id');

    const tspResult = greedyTSP(depot, hospitals);

    const roadGraph = {
      'DEPOT': [['H001',12],['H002',18],['H003',15],['H004',25],['H005',20]],
      'H001':  [['DEPOT',12],['H002',8], ['H003',10],['H004',20],['H005',15]],
      'H002':  [['DEPOT',18],['H001',8], ['H003',12],['H004',18],['H005',14]],
      'H003':  [['DEPOT',15],['H001',10],['H002',12],['H004',22],['H005',18]],
      'H004':  [['DEPOT',25],['H001',20],['H002',18],['H003',22],['H005',12]],
      'H005':  [['DEPOT',20],['H001',15],['H002',14],['H003',18],['H004',12]],
    };
    const { dist } = dijkstra(roadGraph, 'DEPOT');
    const routeWithTimes = tspResult.route.map(id => ({
      id, eta_min: id === 'DEPOT' ? 0 : Math.round(dist[id] || 15),
      hospital: hospitals.find(h => h.id === id) || null,
    }));

    const deliveryId = 'DEL-' + uuidv4().slice(0, 8).toUpperCase();
    await run('INSERT INTO supply_deliveries (id,items_json,total_utility,route_json,total_dist_km,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [deliveryId, JSON.stringify(selected), totalUtility, JSON.stringify(tspResult), tspResult.totalDistKm, 'planned']);

    if (req.app.get('io')) req.app.get('io').emit('truck_loaded', { deliveryId, selected, tspResult, routeWithTimes });
    res.json({ success: true, data: { deliveryId, selected, totalUtility, route: tspResult, routeWithTimes } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/supplies/deliveries', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM supply_deliveries ORDER BY created_at DESC LIMIT 20');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
