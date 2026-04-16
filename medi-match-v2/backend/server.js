require('dotenv').config();
const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server } = require('socket.io');
const cors   = require('cors');
const { initDb, getAll, run } = require('./database');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] } });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.set('io', io);

async function startServer() {
  await initDb();

  // Routes
  app.use('/api/auth',      require('./routes/auth'));
  app.use('/api/emergency', require('./routes/emergency'));
  app.use('/api/hospitals', require('./routes/hospitals'));
  app.use('/api',           require('./routes/other'));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', db: 'neon-postgres', ts: new Date().toISOString() }));

  // Serve static frontend
  app.use(express.static(path.join(__dirname, '../frontend')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

  // Socket.io
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Disconnected:', socket.id));
  });

  // Simulate real-time updates every 15s
  setInterval(async () => {
    try {
      const teams = await getAll("SELECT * FROM rescue_teams WHERE status='en-route'");
      for (const team of teams) {
        const newLat = Number(team.lat) + (Math.random() - 0.5) * 0.003;
        const newLng = Number(team.lng) + (Math.random() - 0.5) * 0.003;
        await run('UPDATE rescue_teams SET lat=$1, lng=$2 WHERE id=$3', [newLat, newLng, team.id]);
        io.emit('team_position_update', { id: team.id, lat: newLat, lng: newLng });
      }
      const totalRow    = await getAll('SELECT COUNT(*) AS cnt FROM victims');
      const critRow     = await getAll("SELECT COUNT(*) AS cnt FROM victims WHERE severity='critical'");
      const activeRow   = await getAll("SELECT COUNT(*) AS cnt FROM rescue_teams WHERE status!='available'");
      const bedsRow     = await getAll('SELECT SUM(available_beds) AS cnt FROM hospitals');
      io.emit('stats_update', {
        totalVictims:    Number(totalRow[0].cnt),
        criticalVictims: Number(critRow[0].cnt),
        activeTeams:     Number(activeRow[0].cnt),
        availableBeds:   Number(bedsRow[0].cnt || 0),
      });
    } catch (_) {}
  }, 15000);

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🚑 MediMatch v2 running on http://localhost:${PORT}`);
    console.log(`   DB: Neon PostgreSQL`);
  });
}

startServer().catch(err => { console.error('Startup failed:', err); process.exit(1); });
