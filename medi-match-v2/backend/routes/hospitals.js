const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getOne, getAll, run } = require('../database');
const { fordFulkerson } = require('../algorithms');
const { authMiddleware, adminOnly } = require('./auth');

// GET /api/hospitals/stats/overview  — admin only
router.get('/stats/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const totals = await getOne(`
      SELECT SUM(total_beds) AS total_beds, SUM(available_beds) AS available_beds,
             SUM(total_icu) AS total_icu, SUM(available_icu) AS available_icu,
             SUM(total_ventilator) AS total_ventilator, SUM(available_ventilator) AS available_ventilator,
             SUM(total_general) AS total_general, SUM(available_general) AS available_general,
             COUNT(*) AS total_hospitals,
             SUM(CASE WHEN status='critical' THEN 1 ELSE 0 END) AS critical_hospitals
      FROM hospitals`);
    const admitted = await getOne(
      "SELECT COUNT(*) AS cnt FROM bed_admissions WHERE DATE(admitted_at) = CURRENT_DATE AND status='admitted'"
    );
    res.json({ success: true, data: { ...totals, admittedToday: Number(admitted.cnt) } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/hospitals  — all auth users can see basic list
router.get('/', authMiddleware, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM hospitals ORDER BY name');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/hospitals/:id  — admin only (detailed + admissions)
router.get('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const hospital = await getOne('SELECT * FROM hospitals WHERE id=$1', [req.params.id]);
    if (!hospital) return res.status(404).json({ success: false, error: 'Not found' });
    const admissions = await getAll(`
      SELECT ba.*, v.name AS victim_name, v.triage_category, v.severity_score
      FROM bed_admissions ba
      JOIN victims v ON ba.victim_id = v.id
      WHERE ba.hospital_id=$1 AND ba.status='admitted'
      ORDER BY ba.admitted_at DESC`, [req.params.id]);
    res.json({ success: true, data: { ...hospital, admissions } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/hospitals/:id/admit  — admin only
router.post('/:id/admit', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { victimId, bedType } = req.body;
    const hospitalId = req.params.id;
    const hospital = await getOne('SELECT * FROM hospitals WHERE id=$1', [hospitalId]);
    const victim   = await getOne('SELECT * FROM victims WHERE id=$1', [victimId]);
    if (!hospital || !victim) return res.status(404).json({ success: false, error: 'Not found' });

    const assignedBedType = bedType || (
      victim.triage_category === 'red' ? 'icu' :
      victim.triage_category === 'yellow' ? 'isolation' : 'general'
    );

    const fieldMap = { icu: 'available_icu', isolation: 'available_isolation', general: 'available_general', ventilator: 'available_ventilator' };
    const field = fieldMap[assignedBedType] || 'available_general';

    if (Number(hospital[field]) <= 0) {
      return res.status(400).json({ success: false, error: `No ${assignedBedType} beds available` });
    }

    const admissionId = uuidv4();
    await run('INSERT INTO bed_admissions (id,victim_id,hospital_id,bed_type,status) VALUES ($1,$2,$3,$4,$5)',
      [admissionId, victimId, hospitalId, assignedBedType, 'admitted']);

    await run(`UPDATE hospitals SET ${field} = ${field} - 1, available_beds = available_beds - 1 WHERE id=$1`, [hospitalId]);
    await run("UPDATE victims SET status='admitted', assigned_hospital_id=$1, admitted_at=NOW() WHERE id=$2", [hospitalId, victimId]);

    const updatedHospital = await getOne('SELECT * FROM hospitals WHERE id=$1', [hospitalId]);
    if (req.app.get('io')) {
      req.app.get('io').emit('bed_allocated', { hospitalId, victimId, bedType: assignedBedType });
      req.app.get('io').emit('hospital_updated', updatedHospital);
    }
    res.json({ success: true, data: { admissionId, bedType: assignedBedType } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/hospitals/discharge/:admissionId  — admin only
router.post('/discharge/:admissionId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const admission = await getOne('SELECT * FROM bed_admissions WHERE id=$1', [req.params.admissionId]);
    if (!admission) return res.status(404).json({ success: false, error: 'Not found' });

    await run("UPDATE bed_admissions SET status='discharged', discharged_at=NOW() WHERE id=$1", [req.params.admissionId]);
    const fieldMap = { icu: 'available_icu', isolation: 'available_isolation', general: 'available_general', ventilator: 'available_ventilator' };
    const field = fieldMap[admission.bed_type] || 'available_general';
    await run(`UPDATE hospitals SET ${field} = ${field} + 1, available_beds = available_beds + 1 WHERE id=$1`, [admission.hospital_id]);
    await run("UPDATE victims SET status='discharged' WHERE id=$1", [admission.victim_id]);

    const hospital = await getOne('SELECT * FROM hospitals WHERE id=$1', [admission.hospital_id]);
    if (req.app.get('io')) {
      req.app.get('io').emit('patient_discharged', { admission });
      req.app.get('io').emit('hospital_updated', hospital);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PATCH /api/hospitals/:id/resources  — admin only
router.patch('/:id/resources', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { oxygen_level, available_icu, available_general, available_isolation } = req.body;
    if (oxygen_level !== undefined) await run('UPDATE hospitals SET oxygen_level=$1 WHERE id=$2', [oxygen_level, req.params.id]);
    if (available_icu !== undefined) await run('UPDATE hospitals SET available_icu=$1 WHERE id=$2', [available_icu, req.params.id]);
    if (available_general !== undefined) await run('UPDATE hospitals SET available_general=$1 WHERE id=$2', [available_general, req.params.id]);
    if (available_isolation !== undefined) await run('UPDATE hospitals SET available_isolation=$1 WHERE id=$2', [available_isolation, req.params.id]);
    const hospital = await getOne('SELECT * FROM hospitals WHERE id=$1', [req.params.id]);
    if (req.app.get('io')) req.app.get('io').emit('hospital_updated', hospital);
    res.json({ success: true, data: hospital });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/hospitals/rebalance  — admin only (Ford-Fulkerson)
router.post('/rebalance', authMiddleware, adminOnly, async (req, res) => {
  try {
    const hospitals = await getAll('SELECT * FROM hospitals');
    const graph = { SOURCE: [], SINK: [] };
    hospitals.forEach(h => { graph[h.id] = []; });
    hospitals.forEach(h => {
      const load = Math.round(((h.total_beds - h.available_beds) / h.total_beds) * 100);
      if (load > 80) graph['SOURCE'].push([h.id, 100 - load]);
      else           graph[h.id].push(['SINK', 100 - load]);
    });
    const result = fordFulkerson(graph, 'SOURCE', 'SINK');
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/hospitals/transfer  — admin only
router.post('/transfer', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { fromHospitalId, toHospitalId, resourceType, amount } = req.body;
    const fromH = await getOne('SELECT * FROM hospitals WHERE id=$1', [fromHospitalId]);
    const toH   = await getOne('SELECT * FROM hospitals WHERE id=$1', [toHospitalId]);
    if (!fromH || !toH) return res.status(404).json({ success: false, error: 'Hospital not found' });

    const fieldMap = { icu:'available_icu', ventilator:'available_ventilator', general:'available_general', isolation:'available_isolation' };
    const field = fieldMap[resourceType] || 'available_general';
    if (Number(fromH[field]) < amount) return res.status(400).json({ success: false, error: 'Insufficient resources' });

    await run(`UPDATE hospitals SET ${field} = ${field} - $1 WHERE id=$2`, [amount, fromHospitalId]);
    await run(`UPDATE hospitals SET ${field} = ${field} + $1 WHERE id=$2`, [amount, toHospitalId]);

    if (req.app.get('io')) req.app.get('io').emit('resource_transfer', { fromHospitalId, toHospitalId, resourceType, amount });
    res.json({ success: true, message: `Transferred ${amount} ${resourceType}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
