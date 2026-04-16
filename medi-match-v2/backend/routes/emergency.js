const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getOne, getAll, run } = require('../database');
const { findNearestTeam, findNearestHospital, haversineDistance, calculateSeverityScore, getTriageCategory, kmpSearch } = require('../algorithms');
const { authMiddleware } = require('./auth');

// GET /api/emergency/incidents
router.get('/incidents', authMiddleware, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM incidents ORDER BY created_at DESC');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/emergency/victims
router.get('/victims', authMiddleware, async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT v.*, t.name AS team_name, h.name AS hospital_name
      FROM victims v
      LEFT JOIN rescue_teams t ON v.assigned_team_id = t.id
      LEFT JOIN hospitals h ON v.assigned_hospital_id = h.id
      ORDER BY v.severity_score DESC`);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/emergency/teams
router.get('/teams', authMiddleware, async (req, res) => {
  try {
    const rows = await getAll('SELECT * FROM rescue_teams');
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/emergency/report  (user + admin)
router.post('/report', authMiddleware, async (req, res) => {
  try {
    const { name, lat, lng, description, type, vitals } = req.body;

    // KMP keyword detection
    const keywords = ['cardiac','stroke','seizure','unconscious','bleeding','respiratory','cholera','epidemic'];
    const detected = keywords.filter(kw => kmpSearch(description || '', kw).length > 0);

    const severityScore = vitals ? calculateSeverityScore(vitals) : Math.min(100, 40 + detected.length * 8);
    const triageCategory = getTriageCategory(severityScore);
    const severity = severityScore >= 75 ? 'critical' : severityScore >= 45 ? 'moderate' : 'mild';

    const victimId = 'V' + uuidv4().substring(0, 6).toUpperCase();
    await run(
      `INSERT INTO victims (id,name,lat,lng,severity,severity_score,status,oxygen_level,heart_rate,
       respiratory_rate,temperature,consciousness,triage_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [victimId, name || 'Unknown', lat, lng, severity, severityScore, 'waiting',
       vitals?.oxygen_level || null, vitals?.heart_rate || null,
       vitals?.respiratory_rate || null, vitals?.temperature || null,
       vitals?.consciousness || 'conscious', triageCategory]
    );

    const incidentId = 'I' + uuidv4().substring(0, 6).toUpperCase();
    await run(
      'INSERT INTO incidents (id,type,description,lat,lng,severity,status,victim_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [incidentId, type || 'medical', description || 'Emergency reported', lat, lng, severity, 'active', 1]
    );

    const teams = await getAll("SELECT * FROM rescue_teams WHERE status = 'available'");
    const nearestTeam = findNearestTeam(lat, lng, teams);

    let assignedTeam = null;
    if (nearestTeam) {
      await run("UPDATE rescue_teams SET status='en-route', current_victim_id=$1 WHERE id=$2", [victimId, nearestTeam.id]);
      await run("UPDATE victims SET assigned_team_id=$1, status='assigned' WHERE id=$2", [nearestTeam.id, victimId]);
      assignedTeam = nearestTeam;
    }

    const victim = await getOne('SELECT * FROM victims WHERE id=$1', [victimId]);
    if (req.app.get('io')) req.app.get('io').emit('new_victim', { victim, team: assignedTeam, incidentId, detectedKeywords: detected });
    res.json({ success: true, data: { victim, team: assignedTeam, incidentId, detectedKeywords: detected, severityScore } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/emergency/dispatch  (admin only)
router.post('/dispatch', authMiddleware, async (req, res) => {
  try {
    const { teamId, victimId } = req.body;
    const team   = await getOne('SELECT * FROM rescue_teams WHERE id=$1', [teamId]);
    const victim = await getOne('SELECT * FROM victims WHERE id=$1', [victimId]);
    if (!team || !victim) return res.status(404).json({ success: false, error: 'Not found' });

    await run("UPDATE rescue_teams SET status='en-route', current_victim_id=$1 WHERE id=$2", [victimId, teamId]);
    await run("UPDATE victims SET assigned_team_id=$1, status='assigned' WHERE id=$2", [teamId, victimId]);

    const distance = haversineDistance(Number(team.lat), Number(team.lng), Number(victim.lat), Number(victim.lng));
    const eta = Math.round((distance / 40) * 60);
    if (req.app.get('io')) req.app.get('io').emit('team_dispatched', { teamId, victimId, eta });
    res.json({ success: true, data: { team, victim, eta, distance } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/emergency/stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const totalVictims    = await getOne('SELECT COUNT(*) AS cnt FROM victims');
    const criticalVictims = await getOne("SELECT COUNT(*) AS cnt FROM victims WHERE severity='critical'");
    const activeTeams     = await getOne("SELECT COUNT(*) AS cnt FROM rescue_teams WHERE status != 'available'");
    const activeIncidents = await getOne("SELECT COUNT(*) AS cnt FROM incidents WHERE status='active'");
    const pendingVictims  = await getOne("SELECT COUNT(*) AS cnt FROM victims WHERE status='waiting' OR status='assigned'");
    res.json({ success: true, data: {
      totalVictims: Number(totalVictims.cnt),
      criticalVictims: Number(criticalVictims.cnt),
      activeTeams: Number(activeTeams.cnt),
      activeIncidents: Number(activeIncidents.cnt),
      pendingVictims: Number(pendingVictims.cnt),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PATCH /api/emergency/teams/:id
router.patch('/teams/:id', authMiddleware, async (req, res) => {
  try {
    const { status, lat, lng } = req.body;
    if (status) await run('UPDATE rescue_teams SET status=$1 WHERE id=$2', [status, req.params.id]);
    if (lat && lng) await run('UPDATE rescue_teams SET lat=$1, lng=$2 WHERE id=$3', [lat, lng, req.params.id]);
    if (req.app.get('io')) req.app.get('io').emit('team_updated', { id: req.params.id, status, lat, lng });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
