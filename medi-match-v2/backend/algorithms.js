/**
 * algorithms.js
 * Calls compiled C++ binary (algorithms_bin) when available.
 * Falls back to pure JS implementations automatically.
 *
 * Compile the C++ binary:
 *   g++ -std=c++17 -O2 -o algorithms_bin algorithms.cpp
 */

const { spawnSync } = require('child_process');
const path = require('path');
const BIN  = path.join(__dirname, 'algorithms_bin');

// ── C++ bridge ───────────────────────────────────────────────────────────────
function callCpp(payload) {
  try {
    const result = spawnSync(BIN, [], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000,
    });
    if (result.status !== 0 || result.error) throw new Error(result.stderr || result.error?.message);
    return JSON.parse(result.stdout.trim());
  } catch {
    return { success: false };
  }
}

// ── 1. Haversine ─────────────────────────────────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const r = callCpp({ cmd:'haversine', lat1, lng1, lat2, lng2 });
  if (r.success) return r.distance;
  const R=6371, rad=d=>d*Math.PI/180;
  const dLat=rad(lat2-lat1), dLng=rad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ── 2. Severity Score ────────────────────────────────────────────────────────
function calculateSeverityScore(vitals) {
  const r = callCpp({ cmd:'severity_score',
    oxygen_level:     vitals.oxygen_level     ?? -1,
    respiratory_rate: vitals.respiratory_rate ?? -1,
    heart_rate:       vitals.heart_rate       ?? -1,
    temperature:      vitals.temperature      ?? -1,
    consciousness:    vitals.consciousness    ?? '',
  });
  if (r.success) return r.score;
  // JS fallback
  let s=0;
  const {oxygen_level:o,respiratory_rate:rr,heart_rate:hr,temperature:t,consciousness:c}=vitals;
  if(o!==undefined){if(o<88)s+=30;else if(o<92)s+=20;else if(o<95)s+=10;}
  if(rr!==undefined){if(rr>30||rr<8)s+=25;else if(rr>25)s+=15;else if(rr>20)s+=5;}
  if(hr!==undefined){if(hr>140||hr<50)s+=20;else if(hr>120)s+=12;else if(hr>100)s+=6;}
  if(t!==undefined){if(t>40||t<35)s+=15;else if(t>39)s+=8;else if(t>38)s+=4;}
  if(c==='unconscious')s+=20;else if(c==='confused')s+=10;else if(c==='drowsy')s+=5;
  return Math.min(s,100);
}

function getTriageCategory(score) {
  if (score>=75) return 'red'; if (score>=45) return 'yellow'; return 'green';
}

// ── 3. KMP search ────────────────────────────────────────────────────────────
function kmpSearch(text, pattern) {
  const r = callCpp({ cmd:'kmp_search', text, pattern });
  if (r.success) return r.positions || [];
  const lps=[]; let len=0; lps[0]=0;
  for(let i=1;i<pattern.length;){
    if(pattern[i].toLowerCase()===pattern[len].toLowerCase()) lps[i++]=++len;
    else len>0?len=lps[len-1]:lps[i++]=0;
  }
  const hits=[]; let i=0,j=0;
  while(i<text.length){
    if(text[i].toLowerCase()===pattern[j].toLowerCase()){i++;j++;}
    if(j===pattern.length){hits.push(i-j);j=lps[j-1];}
    else if(i<text.length&&text[i].toLowerCase()!==pattern[j].toLowerCase()){j>0?j=lps[j-1]:i++;}
  }
  return hits;
}

// ── 4. Find nearest team/hospital (haversine-based greedy) ───────────────────
function findNearestTeam(lat, lng, teams) {
  if (!teams?.length) return null;
  let best=null, bd=Infinity;
  for(const t of teams){
    const d=haversineDistance(lat,lng,Number(t.lat),Number(t.lng));
    if(d<bd){bd=d;best={...t,distance:d};}
  }
  return best;
}

function findNearestHospital(lat, lng, hospitals, bedType='general') {
  if (!hospitals?.length) return null;
  const fmap={icu:'available_icu',ventilator:'available_ventilator',isolation:'available_isolation',general:'available_general'};
  const field=fmap[bedType]||'available_general';
  const elig=hospitals.filter(h=>Number(h[field])>0);
  if(!elig.length) return null;
  let best=null, bd=Infinity;
  for(const h of elig){
    const d=haversineDistance(lat,lng,Number(h.lat),Number(h.lng));
    if(d<bd){bd=d;best={...h,distance:d};}
  }
  return best;
}

// ── 5. QuickSort ─────────────────────────────────────────────────────────────
function quickSort(arr, key='severity_score') {
  const r = callCpp({ cmd:'quicksort', items:arr, key });
  if (r.success) return r.sorted;
  // JS fallback
  if(arr.length<=1)return arr;
  const pivot=arr[Math.floor(arr.length/2)][key];
  return [...quickSort(arr.filter(x=>Number(x[key])>Number(pivot)),key),
          arr.filter(x=>Number(x[key])===Number(pivot)),
          ...quickSort(arr.filter(x=>Number(x[key])<Number(pivot)),key)].flat();
}

// ── 6. Max-Heap ──────────────────────────────────────────────────────────────
class MaxHeap {
  constructor(){this.heap=[];}
  push(item){this.heap.push(item);this._up(this.heap.length-1);}
  extractMax(){
    if(!this.heap.length)return null;
    const max=this.heap[0],last=this.heap.pop();
    if(this.heap.length){this.heap[0]=last;this._down(0);}
    return max;
  }
  _up(i){while(i>0){const p=Math.floor((i-1)/2);if(this.heap[p].severity_score>=this.heap[i].severity_score)break;[this.heap[p],this.heap[i]]=[this.heap[i],this.heap[p]];i=p;}}
  _down(i){const n=this.heap.length;while(true){let lg=i,l=2*i+1,r=2*i+2;if(l<n&&this.heap[l].severity_score>this.heap[lg].severity_score)lg=l;if(r<n&&this.heap[r].severity_score>this.heap[lg].severity_score)lg=r;if(lg===i)break;[this.heap[lg],this.heap[i]]=[this.heap[i],this.heap[lg]];i=lg;}}
  peek(){return this.heap[0]||null;}
  size(){return this.heap.length;}
}

// ── 7. Dijkstra ──────────────────────────────────────────────────────────────
function dijkstra(graph, start) {
  const r = callCpp({ cmd:'dijkstra', graph, source:start });
  if (r.success && r.dist) return { dist:r.dist, prev:{}, path:t=>[] };
  // JS fallback
  const dist={},prev={},visited=new Set();
  Object.keys(graph).forEach(n=>{dist[n]=Infinity;prev[n]=null;});
  dist[start]=0;
  const pq=[[0,start]];
  while(pq.length){
    pq.sort((a,b)=>a[0]-b[0]);
    const[d,u]=pq.shift();
    if(visited.has(u))continue;visited.add(u);
    for(const[v,w]of(graph[u]||[])){const nd=d+w;if(nd<dist[v]){dist[v]=nd;prev[v]=u;pq.push([nd,v]);}}
  }
  function path(t){const p=[];let c=t;while(c){p.unshift(c);c=prev[c];}return p;}
  return{dist,prev,path};
}

// ── 8. 0/1 Knapsack ─────────────────────────────────────────────────────────
function knapsack(items, maxWeightKg) {
  const r = callCpp({ cmd:'knapsack', items, max_weight_kg: maxWeightKg });
  if (r.success) return { totalUtility: r.total_utility, selected: r.selected };
  // JS fallback
  const W=Math.floor(maxWeightKg*10),n=items.length;
  const dp=Array.from({length:n+1},()=>new Array(W+1).fill(0));
  for(let i=1;i<=n;++i){const w=Math.floor(Number(items[i-1].weight_per_unit)*10),v=Number(items[i-1].utility_value);for(let j=0;j<=W;++j){dp[i][j]=dp[i-1][j];if(j>=w)dp[i][j]=Math.max(dp[i][j],dp[i-1][j-w]+v);}}
  const sel=[];let j=W;
  for(let i=n;i>0;--i)if(dp[i][j]!==dp[i-1][j]){sel.push({...items[i-1],qty:1});j-=Math.floor(Number(items[i-1].weight_per_unit)*10);}
  return{totalUtility:dp[n][W],selected:sel};
}

// ── 9. Greedy TSP ────────────────────────────────────────────────────────────
function greedyTSP(depot, hospitals) {
  const hospsPayload = hospitals.map(h=>({id:h.id||h.name,lat:Number(h.lat),lng:Number(h.lng)}));
  const r = callCpp({ cmd:'greedy_tsp', depot_id:depot.id||'DEPOT',
    depot_lat:Number(depot.lat), depot_lng:Number(depot.lng), hospitals:hospsPayload });
  if (r.success) return { route:r.route, totalDistKm:r.total_dist_km };
  // JS fallback
  const unvisited=[...hospitals]; const route=[depot]; let cur=depot;
  while(unvisited.length){let best=null,bd=Infinity;for(const h of unvisited){const d=haversineDistance(cur.lat,cur.lng,Number(h.lat),Number(h.lng));if(d<bd){bd=d;best=h;}}route.push(best);unvisited.splice(unvisited.indexOf(best),1);cur=best;}
  route.push(depot);
  const totalDistKm=Math.round(route.reduce((s,n,i)=>i===0?0:s+haversineDistance(route[i-1].lat,route[i-1].lng,n.lat,n.lng),0)*10)/10;
  return{route:route.map(r=>r.id||r.name),totalDistKm};
}

// ── 10. Ford-Fulkerson ───────────────────────────────────────────────────────
function fordFulkerson(graph, source, sink) {
  const r = callCpp({ cmd:'ford_fulkerson', graph, source, sink });
  if (r.success) return { maxFlow:r.max_flow, paths:r.paths||[] };
  // JS fallback (Edmonds-Karp / BFS augmenting)
  const residual={};
  for(const u of Object.keys(graph)){if(!residual[u])residual[u]={};for(const[v,cap]of(graph[u]||[])){residual[u][v]=(residual[u][v]||0)+cap;if(!residual[v])residual[v]={};residual[v][u]=residual[v][u]||0;}}
  function bfs(){const vis={[source]:true},q=[[source,[]]];while(q.length){const[u,p]=q.shift();for(const v of Object.keys(residual[u]||{})){if(!vis[v]&&residual[u][v]>0){vis[v]=true;const np=[...p,[u,v]];if(v===sink)return np;q.push([v,np]);}}}return null;}
  let maxFlow=0;const paths=[];let p;
  while((p=bfs())){const flow=Math.min(...p.map(([u,v])=>residual[u][v]));for(const[u,v]of p){residual[u][v]-=flow;residual[v][u]+=flow;}maxFlow+=flow;paths.push({path:p.map(([u])=>u).concat(sink),flow});}
  return{maxFlow,paths};
}

// ── 11. Gale-Shapley ─────────────────────────────────────────────────────────
function galeShapley(patients, doctors) {
  const r = callCpp({ cmd:'gale_shapley', patients, doctors });
  if (r.success) return r.matching;
  // JS fallback
  const freeP=[...patients.map(p=>p.id)],next={},dMatch={},pMatch={};
  patients.forEach(p=>{next[p.id]=0;});
  doctors.forEach(d=>{dMatch[d.id]=[];});
  const dRank={};
  doctors.forEach(d=>{dRank[d.id]={};d.preferences.forEach((pid,i)=>{dRank[d.id][pid]=i;});});
  const dCap={};doctors.forEach(d=>{dCap[d.id]=d.capacity||1;});
  while(freeP.length){
    const pid=freeP.shift();const pat=patients.find(p=>p.id===pid);
    if(!pat||next[pid]>=pat.preferences.length)continue;
    const did=pat.preferences[next[pid]++];
    dMatch[did].push(pid);pMatch[pid]=did;
    if(dMatch[did].length>dCap[did]){
      const ranked=dMatch[did].sort((a,b)=>(dRank[did][a]??999)-(dRank[did][b]??999));
      const rej=ranked.pop();dMatch[did]=ranked;delete pMatch[rej];freeP.push(rej);
    }
  }
  return pMatch;
}

module.exports = {
  haversineDistance, calculateSeverityScore, getTriageCategory,
  kmpSearch, findNearestTeam, findNearestHospital,
  quickSort, MaxHeap, dijkstra,
  knapsack, greedyTSP, fordFulkerson, galeShapley,
};
