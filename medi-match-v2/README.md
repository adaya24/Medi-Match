# MediMatch v2 — Full-Stack Disaster Response Platform

## Stack
- **Frontend**: Vanilla HTML/CSS/JS + Leaflet.js (no build step needed)
- **Backend**: Node.js + Express + Socket.io
- **Database**: Neon PostgreSQL (cloud-hosted)
- **Auth**: JWT (bcryptjs)

---

## Quick Start

```bash
cd backend
npm install
node server.js
# Open http://localhost:5000
```

The frontend is served statically by Express — no separate frontend server needed.

---

## Login Credentials

| Role  | Username | Password | Access |
|-------|----------|----------|--------|
| Admin | `admin`  | `admin123` | All 5 pages |
| User  | `user1`  | `user123`  | Emergency page only |

---

## Page Access by Role

| Page | URL | Admin | User |
|------|-----|-------|------|
| Login | `login.html` | ✓ | ✓ |
| Command Center | `index.html` | ✓ | ✗ |
| Hospital Mgmt | `hospitals.html` | ✓ | ✗ |
| Medical Triage | `triage.html` | ✓ | ✗ |
| Supply Mgmt | `supply.html` | ✓ | ✗ |
| Request Emergency | `emergency.html` | ✓ | ✓ |

---

## Algorithms by Dashboard

### Request Emergency (User + Admin)
- **KMP + Rabin-Karp** — keyword scan on incident description
- **BFS** — outbreak spread zone detection  
- **Dijkstra** — optimal rescue team routing
- **Haversine** — nearest team/hospital distance

### Hospital Management (Admin only)
- **Hash Table O(1)** — instant bed lookup by hospital ID
- **Ford-Fulkerson** — network flow rebalancing across hospitals
- **Gale-Shapley** — patient-to-doctor stable matching on admit

### Medical Triage (Admin only)
- **QuickSort** — sort triage queue by severity score (descending)
- **Max-Heap** — O(log n) priority queue for bed assignment
- **Multi-parameter scorer** — SpO2 + HR + RR + temp + consciousness → 0–100 score

### Supply Management (Admin only)
- **0/1 Knapsack** — optimal supply selection given truck weight limit
- **Greedy TSP** — nearest-neighbor multi-hospital delivery order
- **Dijkstra** — shortest road path per delivery leg

---

## Database — Neon PostgreSQL

```
postgresql://neondb_owner:npg_3F9vqlxKejha@ep-proud-grass-am34bkgs-pooler.c-5.us-east-1.aws.neon.tech/neondb
```

Tables: `users`, `hospitals`, `rescue_teams`, `victims`, `incidents`, `supplies`, `bed_admissions`, `supply_deliveries`

Schema auto-creates and seeds on first run.

---

## API Reference

### Auth
- `POST /api/auth/login` — `{ username, password }` → `{ token, user }`
- `POST /api/auth/register` — create user

### Emergency (requires Bearer token)
- `GET  /api/emergency/stats`
- `GET  /api/emergency/victims`
- `GET  /api/emergency/teams`
- `GET  /api/emergency/incidents`
- `POST /api/emergency/report` — `{ name, lat, lng, type, description, vitals? }`
- `POST /api/emergency/dispatch` — `{ teamId, victimId }` (admin)
- `PATCH /api/emergency/teams/:id`

### Hospitals (admin only)
- `GET  /api/hospitals`
- `GET  /api/hospitals/stats/overview`
- `GET  /api/hospitals/:id`
- `POST /api/hospitals/:id/admit` — `{ victimId, bedType }`
- `POST /api/hospitals/discharge/:admissionId`
- `POST /api/hospitals/rebalance` — Ford-Fulkerson
- `POST /api/hospitals/transfer` — `{ fromHospitalId, toHospitalId, resourceType, amount }`
- `PATCH /api/hospitals/:id/resources`

### Triage (admin only)
- `GET  /api/triage`
- `PATCH /api/triage/:id/vitals`

### Supplies (admin only)
- `GET  /api/supplies`
- `PATCH /api/supplies/:id`
- `POST /api/supplies/load-truck` — `{ max_weight_kg, hospital_ids }` → Knapsack + TSP
- `GET  /api/supplies/deliveries`

---

## Socket.io Events (Server → Client)
| Event | Payload |
|-------|---------|
| `new_victim` | `{ victim, team, incidentId, detectedKeywords }` |
| `team_dispatched` | `{ teamId, victimId, eta }` |
| `team_updated` | `{ id, status, lat, lng }` |
| `team_position_update` | `{ id, lat, lng }` |
| `hospital_updated` | hospital object |
| `bed_allocated` | `{ hospitalId, victimId, bedType }` |
| `patient_discharged` | `{ admission }` |
| `resource_transfer` | `{ fromHospitalId, toHospitalId, resourceType, amount }` |
| `vitals_updated` | victim object |
| `supply_updated` | supply object |
| `truck_loaded` | `{ deliveryId, selected, tspResult }` |
| `stats_update` | `{ totalVictims, criticalVictims, activeTeams, availableBeds }` |
