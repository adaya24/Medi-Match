/**
 * algorithms.cpp  —  MediMatch Disaster Response DSA Core
 * ========================================================
 * Compile:  g++ -std=c++17 -O2 -o algorithms_bin algorithms.cpp
 * Usage:    echo '<json>' | ./algorithms_bin
 *
 * Input:  JSON on stdin  { "cmd": "<algorithm>", ...params }
 * Output: JSON on stdout { "success": true/false, ...result }
 *
 * Supported commands:
 *   haversine          distance between two lat/lng points
 *   severity_score     multi-parameter triage scorer
 *   triage_category    score → RED/YELLOW/GREEN
 *   kmp_search         KMP pattern match in text
 *   bfs_spread         BFS outbreak zone expansion
 *   dijkstra           single-source shortest path
 *   quicksort          sort victim array by severity_score
 *   knapsack           0/1 knapsack optimal supply loading
 *   greedy_tsp         nearest-neighbour TSP for delivery route
 *   ford_fulkerson     max-flow for hospital network rebalancing
 */

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <map>
#include <queue>
#include <algorithm>
#include <cmath>
#include <climits>
#include <cassert>
#include <stdexcept>

// ─────────────────────────────────────────────────────────────────────────────
// Minimal JSON parser/writer (no external dependencies)
// ─────────────────────────────────────────────────────────────────────────────

// We use a simple key-value map for JSON input and string building for output.
// For the complexity of a full JSON parser we keep things practical:
// numbers, strings, booleans, arrays of objects/numbers, nested objects.

struct JsonVal;
using JsonObj = std::unordered_map<std::string, JsonVal>;
using JsonArr = std::vector<JsonVal>;

struct JsonVal {
    enum Type { NIL, BOOL, NUM, STR, ARR, OBJ } type = NIL;
    bool   b  = false;
    double n  = 0;
    std::string s;
    JsonArr  arr;
    JsonObj  obj;

    JsonVal() : type(NIL) {}
    explicit JsonVal(bool v)        : type(BOOL), b(v) {}
    explicit JsonVal(double v)      : type(NUM),  n(v) {}
    explicit JsonVal(const std::string& v) : type(STR), s(v) {}
    explicit JsonVal(std::string&&  v) : type(STR), s(std::move(v)) {}
    explicit JsonVal(JsonArr v)     : type(ARR), arr(std::move(v)) {}
    explicit JsonVal(JsonObj v)     : type(OBJ), obj(std::move(v)) {}

    bool   asBool()   const { return type==BOOL ? b : (type==NUM ? n!=0 : false); }
    double asDouble() const { return type==NUM  ? n : 0.0; }
    int    asInt()    const { return (int)asDouble(); }
    const std::string& asStr() const { static std::string empty; return type==STR ? s : empty; }
    bool has(const std::string& k) const { return type==OBJ && obj.count(k); }
    const JsonVal& get(const std::string& k) const {
        static JsonVal nil; if (type==OBJ) { auto it=obj.find(k); if(it!=obj.end()) return it->second; } return nil;
    }
};

static void skipWS(const std::string& s, size_t& i) {
    while (i<s.size() && (s[i]==' '||s[i]=='\t'||s[i]=='\n'||s[i]=='\r')) ++i;
}

static JsonVal parseValue(const std::string& s, size_t& i);

static std::string parseString(const std::string& s, size_t& i) {
    ++i; // skip "
    std::string r;
    while (i<s.size() && s[i]!='"') {
        if (s[i]=='\\' && i+1<s.size()) { ++i; r+=s[i]; }
        else r+=s[i];
        ++i;
    }
    ++i; // skip closing "
    return r;
}

static JsonVal parseObject(const std::string& s, size_t& i) {
    ++i; skipWS(s,i);
    JsonObj obj;
    while (i<s.size() && s[i]!='}') {
        if (s[i]==',') { ++i; skipWS(s,i); continue; }
        std::string key = parseString(s,i);
        skipWS(s,i); ++i; skipWS(s,i); // skip :
        obj[key] = parseValue(s,i);
        skipWS(s,i);
    }
    ++i;
    return JsonVal(std::move(obj));
}

static JsonVal parseArray(const std::string& s, size_t& i) {
    ++i; skipWS(s,i);
    JsonArr arr;
    while (i<s.size() && s[i]!=']') {
        if (s[i]==',') { ++i; skipWS(s,i); continue; }
        arr.push_back(parseValue(s,i));
        skipWS(s,i);
    }
    ++i;
    return JsonVal(std::move(arr));
}

static JsonVal parseValue(const std::string& s, size_t& i) {
    skipWS(s,i);
    if (i>=s.size()) return JsonVal();
    if (s[i]=='"') return JsonVal(parseString(s,i));
    if (s[i]=='{') return parseObject(s,i);
    if (s[i]=='[') return parseArray(s,i);
    if (s.substr(i,4)=="true")  { i+=4; return JsonVal(true);  }
    if (s.substr(i,5)=="false") { i+=5; return JsonVal(false); }
    if (s.substr(i,4)=="null")  { i+=4; return JsonVal();      }
    // number
    size_t j=i;
    if (s[j]=='-') ++j;
    while (j<s.size() && (isdigit(s[j])||s[j]=='.'||s[j]=='e'||s[j]=='E'||s[j]=='+'||s[j]=='-')) ++j;
    double v = std::stod(s.substr(i, j-i));
    i=j;
    return JsonVal(v);
}

static JsonVal parseJSON(const std::string& src) {
    size_t i=0; return parseValue(src,i);
}

// JSON writer
static std::string toJSON(const JsonVal& v) {
    switch(v.type) {
    case JsonVal::NIL:  return "null";
    case JsonVal::BOOL: return v.b ? "true" : "false";
    case JsonVal::NUM: {
        // integer if whole
        if (v.n == (long long)v.n) return std::to_string((long long)v.n);
        std::ostringstream os; os << v.n; return os.str();
    }
    case JsonVal::STR: {
        std::string r = "\"";
        for (char c : v.s) { if(c=='"'||c=='\\') r+='\\'; r+=c; }
        return r + "\"";
    }
    case JsonVal::ARR: {
        std::string r = "[";
        for (size_t k=0;k<v.arr.size();++k) { if(k) r+=","; r+=toJSON(v.arr[k]); }
        return r+"]";
    }
    case JsonVal::OBJ: {
        std::string r = "{";
        bool first=true;
        for (auto& [k,val] : v.obj) {
            if(!first) r+=","; first=false;
            r+="\""+k+"\":"+toJSON(val);
        }
        return r+"}";
    }
    }
    return "null";
}

static JsonVal makeObj(std::initializer_list<std::pair<std::string,JsonVal>> items) {
    JsonObj o; for(auto& [k,v]:items) o[k]=v; return JsonVal(std::move(o));
}
static JsonVal makeArr(std::vector<JsonVal> a) { return JsonVal(std::move(a)); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. Haversine Distance
// ─────────────────────────────────────────────────────────────────────────────
static const double PI  = 3.14159265358979323846;
static const double R_EARTH = 6371.0; // km

static double toRad(double deg) { return deg * PI / 180.0; }

double haversine(double lat1, double lng1, double lat2, double lng2) {
    double dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
    double a = std::sin(dLat/2)*std::sin(dLat/2)
             + std::cos(toRad(lat1))*std::cos(toRad(lat2))
             * std::sin(dLng/2)*std::sin(dLng/2);
    return R_EARTH * 2.0 * std::atan2(std::sqrt(a), std::sqrt(1.0-a));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Severity Score (multi-parameter triage)
// ─────────────────────────────────────────────────────────────────────────────
int severityScore(double spo2, double rr, double hr, double temp, const std::string& consciousness) {
    int score = 0;
    // SpO2
    if (spo2 > 0) {
        if      (spo2 < 88) score += 30;
        else if (spo2 < 92) score += 20;
        else if (spo2 < 95) score += 10;
    }
    // Respiratory rate
    if (rr > 0) {
        if      (rr > 30 || rr < 8)  score += 25;
        else if (rr > 25)             score += 15;
        else if (rr > 20)             score += 5;
    }
    // Heart rate
    if (hr > 0) {
        if      (hr > 140 || hr < 50) score += 20;
        else if (hr > 120)            score += 12;
        else if (hr > 100)            score += 6;
    }
    // Temperature
    if (temp > 0) {
        if      (temp > 40.0 || temp < 35.0) score += 15;
        else if (temp > 39.0)                score += 8;
        else if (temp > 38.0)                score += 4;
    }
    // Consciousness
    if      (consciousness == "unconscious") score += 20;
    else if (consciousness == "confused")    score += 10;
    else if (consciousness == "drowsy")      score += 5;

    return std::min(score, 100);
}

std::string triageCategory(int score) {
    if (score >= 75) return "red";
    if (score >= 45) return "yellow";
    return "green";
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. KMP String Search
// ─────────────────────────────────────────────────────────────────────────────
std::vector<int> buildLPS(const std::string& pat) {
    int m = (int)pat.size();
    std::vector<int> lps(m, 0);
    for (int i=1,len=0; i<m;) {
        if (tolower(pat[i]) == tolower(pat[len])) lps[i++] = ++len;
        else if (len)                              len = lps[len-1];
        else                                       lps[i++] = 0;
    }
    return lps;
}

std::vector<int> kmpSearch(const std::string& text, const std::string& pat) {
    std::vector<int> matches;
    if (pat.empty()) return matches;
    auto lps = buildLPS(pat);
    int n=(int)text.size(), m=(int)pat.size();
    for (int i=0,j=0; i<n;) {
        if (tolower(text[i]) == tolower(pat[j])) { ++i; ++j; }
        if (j == m)           { matches.push_back(i-j); j = lps[j-1]; }
        else if (i<n && tolower(text[i])!=tolower(pat[j])) {
            if (j) j = lps[j-1]; else ++i;
        }
    }
    return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. BFS — Outbreak Spread Zone Mapping
// ─────────────────────────────────────────────────────────────────────────────
struct BFSResult {
    std::vector<std::string> high, medium, low;
};

BFSResult bfsSpread(const std::unordered_map<std::string,std::vector<std::string>>& graph,
                    const std::string& epicenter) {
    BFSResult res;
    std::unordered_map<std::string,int> dist;
    std::queue<std::string> q;
    dist[epicenter] = 0;
    q.push(epicenter);
    while (!q.empty()) {
        auto u = q.front(); q.pop();
        int d = dist[u];
        if (d == 1) res.high.push_back(u);
        else if (d == 2) res.medium.push_back(u);
        else if (d >= 3) res.low.push_back(u);
        if (d < 3) {
            auto it = graph.find(u);
            if (it != graph.end()) {
                for (auto& v : it->second) {
                    if (!dist.count(v)) { dist[v] = d+1; q.push(v); }
                }
            }
        }
    }
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Dijkstra — Shortest Path
// ─────────────────────────────────────────────────────────────────────────────
struct DijkResult {
    std::unordered_map<std::string,double> dist;
    std::unordered_map<std::string,std::string> prev;
};

DijkResult dijkstra(const std::unordered_map<std::string,std::vector<std::pair<std::string,double>>>& graph,
                    const std::string& src) {
    DijkResult res;
    for (auto& [k,_] : graph) { res.dist[k] = 1e18; res.prev[k] = ""; }
    res.dist[src] = 0;
    // min-heap: (dist, node)
    using P = std::pair<double,std::string>;
    std::priority_queue<P,std::vector<P>,std::greater<P>> pq;
    pq.push({0, src});
    while (!pq.empty()) {
        auto [d,u] = pq.top(); pq.pop();
        if (d > res.dist[u] + 1e-9) continue;
        auto it = graph.find(u);
        if (it == graph.end()) continue;
        for (auto& [v,w] : it->second) {
            double nd = d + w;
            if (nd < res.dist[v]) {
                res.dist[v] = nd; res.prev[v] = u;
                pq.push({nd, v});
            }
        }
    }
    return res;
}

std::vector<std::string> reconstructPath(const DijkResult& res, const std::string& target) {
    std::vector<std::string> path;
    for (std::string cur = target; !cur.empty(); cur = res.prev.count(cur)?res.prev.at(cur):"") {
        path.push_back(cur);
        if (res.prev.count(cur)==0 || res.prev.at(cur).empty()) break;
    }
    std::reverse(path.begin(), path.end());
    return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. QuickSort — Sort victims descending by severity_score
// ─────────────────────────────────────────────────────────────────────────────
void quickSort(std::vector<JsonVal>& arr, const std::string& key, int lo, int hi) {
    if (lo >= hi) return;
    double pivot = arr[(lo+hi)/2].get(key).asDouble();
    int l=lo, r=hi;
    while (l<=r) {
        while (arr[l].get(key).asDouble() > pivot) ++l; // descending
        while (arr[r].get(key).asDouble() < pivot) --r;
        if (l<=r) { std::swap(arr[l],arr[r]); ++l; --r; }
    }
    quickSort(arr,key,lo,r);
    quickSort(arr,key,l,hi);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Max-Heap Priority Queue (for triage bed assignment)
// ─────────────────────────────────────────────────────────────────────────────
struct MaxHeap {
    std::vector<JsonVal> heap;
    std::string scoreKey;
    MaxHeap(const std::string& k="severity_score") : scoreKey(k) {}

    void push(JsonVal v) {
        heap.push_back(std::move(v));
        int i = (int)heap.size()-1;
        while (i>0) {
            int p=(i-1)/2;
            if (heap[p].get(scoreKey).asDouble() < heap[i].get(scoreKey).asDouble()) {
                std::swap(heap[p],heap[i]); i=p;
            } else break;
        }
    }

    JsonVal extractMax() {
        if (heap.empty()) return JsonVal();
        JsonVal top = heap[0];
        heap[0] = heap.back(); heap.pop_back();
        int i=0, n=(int)heap.size();
        while (true) {
            int l=2*i+1, r=2*i+2, lg=i;
            if (l<n && heap[l].get(scoreKey).asDouble()>heap[lg].get(scoreKey).asDouble()) lg=l;
            if (r<n && heap[r].get(scoreKey).asDouble()>heap[lg].get(scoreKey).asDouble()) lg=r;
            if (lg==i) break;
            std::swap(heap[i],heap[lg]); i=lg;
        }
        return top;
    }

    const JsonVal& peek() const { return heap.front(); }
    bool empty() const { return heap.empty(); }
    int  size()  const { return (int)heap.size(); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. 0/1 Knapsack — Optimal Supply Loading
// ─────────────────────────────────────────────────────────────────────────────
struct KnapsackResult {
    int totalUtility;
    std::vector<int> selectedIndices;
};

KnapsackResult knapsack01(const std::vector<double>& weights,
                           const std::vector<int>&    utilities,
                           double maxWeightKg) {
    int n  = (int)weights.size();
    int W  = (int)(maxWeightKg * 10.0); // work in 0.1kg units
    std::vector<std::vector<int>> dp(n+1, std::vector<int>(W+1, 0));
    for (int i=1; i<=n; ++i) {
        int w = (int)(weights[i-1] * 10.0);
        int v = utilities[i-1];
        for (int j=0; j<=W; ++j) {
            dp[i][j] = dp[i-1][j];
            if (j>=w) dp[i][j] = std::max(dp[i][j], dp[i-1][j-w] + v);
        }
    }
    KnapsackResult res;
    res.totalUtility = dp[n][W];
    int j=W;
    for (int i=n; i>0; --i) {
        if (dp[i][j] != dp[i-1][j]) {
            res.selectedIndices.push_back(i-1);
            j -= (int)(weights[i-1]*10.0);
        }
    }
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Greedy TSP — Nearest Neighbour Multi-Stop Delivery
// ─────────────────────────────────────────────────────────────────────────────
struct TSPResult {
    std::vector<std::string> route;
    double totalDistKm;
};

TSPResult greedyTSP(const std::string& depotId, double depotLat, double depotLng,
                    const std::vector<std::tuple<std::string,double,double>>& hospitals) {
    TSPResult res;
    res.totalDistKm = 0;
    std::vector<bool> visited(hospitals.size(), false);
    res.route.push_back(depotId);
    double curLat = depotLat, curLng = depotLng;

    for (size_t step=0; step<hospitals.size(); ++step) {
        double best = 1e18; int bi=-1;
        for (size_t k=0; k<hospitals.size(); ++k) {
            if (visited[k]) continue;
            double d = haversine(curLat, curLng,
                                 std::get<1>(hospitals[k]), std::get<2>(hospitals[k]));
            if (d < best) { best=d; bi=(int)k; }
        }
        if (bi<0) break;
        visited[bi] = true;
        res.route.push_back(std::get<0>(hospitals[bi]));
        res.totalDistKm += best;
        curLat = std::get<1>(hospitals[bi]);
        curLng = std::get<2>(hospitals[bi]);
    }
    // return to depot
    res.route.push_back(depotId);
    res.totalDistKm += haversine(curLat, curLng, depotLat, depotLng);
    res.totalDistKm = std::round(res.totalDistKm * 10.0) / 10.0;
    return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Ford-Fulkerson — Max Flow for Hospital Network Rebalancing
//     (BFS augmenting paths = Edmonds-Karp)
// ─────────────────────────────────────────────────────────────────────────────
struct FFResult {
    int maxFlow;
    std::vector<std::pair<std::vector<std::string>,int>> paths; // (path, flow)
};

// Using integer capacities for clarity
FFResult fordFulkerson(const std::vector<std::string>& nodes,
                       const std::unordered_map<std::string,std::unordered_map<std::string,int>>& cap,
                       const std::string& src, const std::string& sink) {
    // Build index map
    std::unordered_map<std::string,int> idx;
    int N=(int)nodes.size();
    for (int i=0;i<N;++i) idx[nodes[i]]=i;

    // Residual capacity matrix
    std::vector<std::vector<int>> res(N, std::vector<int>(N,0));
    for (auto& [u,mp] : cap)
        for (auto& [v,c] : mp)
            if (idx.count(u)&&idx.count(v))
                res[idx[u]][idx[v]] += c;

    int S = idx.count(src)  ? idx[src]  : -1;
    int T = idx.count(sink) ? idx[sink] : -1;
    if (S<0||T<0) return {0,{}};

    FFResult result; result.maxFlow=0;

    // BFS to find augmenting path
    auto bfsPath = [&]() -> std::vector<int> {
        std::vector<int> parent(N,-1);
        std::vector<bool> vis(N,false);
        std::queue<int> q; q.push(S); vis[S]=true;
        while (!q.empty()&&!vis[T]) {
            int u=q.front(); q.pop();
            for (int v=0;v<N;++v)
                if (!vis[v]&&res[u][v]>0) { vis[v]=true; parent[v]=u; q.push(v); }
        }
        if (!vis[T]) return {};
        std::vector<int> path;
        for (int v=T; v!=S; v=parent[v]) path.push_back(v);
        path.push_back(S);
        std::reverse(path.begin(),path.end());
        return path;
    };

    std::vector<int> path;
    while (!(path=bfsPath()).empty()) {
        // Find min capacity
        int flow=INT_MAX;
        for (int i=0;i+1<(int)path.size();++i) flow=std::min(flow,res[path[i]][path[i+1]]);
        // Update residual
        for (int i=0;i+1<(int)path.size();++i) { res[path[i]][path[i+1]]-=flow; res[path[i+1]][path[i]]+=flow; }
        result.maxFlow += flow;
        // Record path
        std::vector<std::string> namedPath;
        for (int v : path) namedPath.push_back(nodes[v]);
        result.paths.push_back({namedPath, flow});
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Gale-Shapley Stable Matching (patients → doctors)
// ─────────────────────────────────────────────────────────────────────────────
// patients: list of {id, preferences:[doctorId,...]}
// doctors:  list of {id, preferences:[patientId,...], capacity:1}
// Returns: map patientId -> doctorId
std::unordered_map<std::string,std::string> galeShapley(
    const std::vector<std::pair<std::string,std::vector<std::string>>>& patients,
    const std::vector<std::tuple<std::string,std::vector<std::string>,int>>& doctors)
{
    // Doctor rank lookup: doctorId -> {patientId -> rank}
    std::unordered_map<std::string,std::unordered_map<std::string,int>> dRank;
    std::unordered_map<std::string,int> dCap;
    for (auto& [did,prefs,cap] : doctors) {
        dCap[did] = cap;
        for (int i=0;i<(int)prefs.size();++i) dRank[did][prefs[i]] = i;
    }

    std::unordered_map<std::string,int>         nextProposal;
    std::unordered_map<std::string,std::string> patientMatch; // patient -> doctor
    std::unordered_map<std::string,std::vector<std::string>> doctorMatch; // doctor -> [patients]

    std::queue<std::string> free;
    for (auto& [pid,_] : patients) { free.push(pid); nextProposal[pid]=0; }

    auto pPrefs = [&](const std::string& pid) -> const std::vector<std::string>& {
        static std::vector<std::string> empty;
        for (auto& [id,prefs] : patients) if (id==pid) return prefs;
        return empty;
    };

    while (!free.empty()) {
        std::string pid = free.front(); free.pop();
        auto& prefs = pPrefs(pid);
        if (nextProposal[pid] >= (int)prefs.size()) continue;
        std::string did = prefs[nextProposal[pid]++];

        doctorMatch[did].push_back(pid);
        patientMatch[pid] = did;

        if ((int)doctorMatch[did].size() > dCap[did]) {
            // Reject worst-ranked
            auto& dm = doctorMatch[did];
            std::sort(dm.begin(),dm.end(),[&](const std::string& a, const std::string& b){
                return dRank[did].count(a) && dRank[did].count(b) ? dRank[did][a] < dRank[did][b] : true;
            });
            std::string rejected = dm.back(); dm.pop_back();
            patientMatch.erase(rejected);
            free.push(rejected);
        }
    }
    return patientMatch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command dispatcher
// ─────────────────────────────────────────────────────────────────────────────
JsonVal dispatch(const JsonVal& req) {
    std::string cmd = req.get("cmd").asStr();

    // ── haversine ──────────────────────────────────────────────────────────
    if (cmd == "haversine") {
        double lat1=req.get("lat1").asDouble(), lng1=req.get("lng1").asDouble();
        double lat2=req.get("lat2").asDouble(), lng2=req.get("lng2").asDouble();
        double d = haversine(lat1,lng1,lat2,lng2);
        return makeObj({{"success",JsonVal(true)},{"distance",JsonVal(d)}});
    }

    // ── severity_score ─────────────────────────────────────────────────────
    if (cmd == "severity_score") {
        double spo2=req.get("oxygen_level").asDouble();
        double rr  =req.get("respiratory_rate").asDouble();
        double hr  =req.get("heart_rate").asDouble();
        double temp=req.get("temperature").asDouble();
        std::string con=req.get("consciousness").asStr();
        int score = severityScore(spo2,rr,hr,temp,con);
        return makeObj({{"success",JsonVal(true)},{"score",JsonVal((double)score)},
                        {"category",JsonVal(triageCategory(score))}});
    }

    // ── triage_category ────────────────────────────────────────────────────
    if (cmd == "triage_category") {
        int score = req.get("score").asInt();
        return makeObj({{"success",JsonVal(true)},{"category",JsonVal(triageCategory(score))}});
    }

    // ── kmp_search ─────────────────────────────────────────────────────────
    if (cmd == "kmp_search") {
        std::string text = req.get("text").asStr();
        const auto& patsV = req.get("patterns");
        std::vector<std::string> found;
        if (patsV.type == JsonVal::ARR) {
            for (auto& p : patsV.arr) {
                std::string pat = p.asStr();
                if (!kmpSearch(text,pat).empty()) found.push_back(pat);
            }
        } else {
            std::string pat = req.get("pattern").asStr();
            auto hits = kmpSearch(text,pat);
            JsonArr posArr; for (int h:hits) posArr.push_back(JsonVal((double)h));
            return makeObj({{"success",JsonVal(true)},{"count",JsonVal((double)hits.size())},
                            {"positions",makeArr(posArr)}});
        }
        JsonArr fa; for (auto& f:found) fa.push_back(JsonVal(f));
        return makeObj({{"success",JsonVal(true)},{"matched",makeArr(fa)},{"count",JsonVal((double)found.size())}});
    }

    // ── bfs_spread ─────────────────────────────────────────────────────────
    if (cmd == "bfs_spread") {
        std::string epicenter = req.get("epicenter").asStr();
        const auto& graphV    = req.get("graph");
        std::unordered_map<std::string,std::vector<std::string>> graph;
        if (graphV.type == JsonVal::OBJ) {
            for (auto& [k,v] : graphV.obj) {
                std::vector<std::string> nbrs;
                if (v.type == JsonVal::ARR) for (auto& n : v.arr) nbrs.push_back(n.asStr());
                graph[k] = nbrs;
            }
        }
        auto res = bfsSpread(graph, epicenter);
        auto toJA = [](const std::vector<std::string>& v) {
            JsonArr a; for (auto& s:v) a.push_back(JsonVal(s)); return makeArr(a);
        };
        return makeObj({{"success",JsonVal(true)},
                        {"high",toJA(res.high)},{"medium",toJA(res.medium)},{"low",toJA(res.low)}});
    }

    // ── dijkstra ───────────────────────────────────────────────────────────
    if (cmd == "dijkstra") {
        std::string src = req.get("source").asStr();
        const auto& gV  = req.get("graph");
        std::unordered_map<std::string,std::vector<std::pair<std::string,double>>> graph;
        if (gV.type == JsonVal::OBJ) {
            for (auto& [k,adj] : gV.obj) {
                if (adj.type != JsonVal::ARR) continue;
                for (auto& edge : adj.arr) {
                    if (edge.type==JsonVal::ARR && edge.arr.size()>=2)
                        graph[k].push_back({edge.arr[0].asStr(), edge.arr[1].asDouble()});
                }
            }
        }
        auto res = dijkstra(graph, src);
        // Build dist and path for each target
        std::string target = req.get("target").asStr();
        if (!target.empty()) {
            double d = res.dist.count(target) ? res.dist[target] : -1;
            auto path = reconstructPath(res, target);
            JsonArr pa; for (auto& s:path) pa.push_back(JsonVal(s));
            return makeObj({{"success",JsonVal(true)},{"distance",JsonVal(d)},{"path",makeArr(pa)}});
        }
        // Return all distances
        JsonObj distMap;
        for (auto& [k,v] : res.dist) distMap[k] = JsonVal(v);
        return makeObj({{"success",JsonVal(true)},{"dist",JsonVal(std::move(distMap))}});
    }

    // ── quicksort ──────────────────────────────────────────────────────────
    if (cmd == "quicksort") {
        const auto& arrV = req.get("items");
        std::string key  = req.get("key").asStr();
        if (key.empty()) key = "severity_score";
        std::vector<JsonVal> items;
        if (arrV.type == JsonVal::ARR) items = arrV.arr;
        if (!items.empty()) quickSort(items, key, 0, (int)items.size()-1);
        JsonArr out; for (auto& v:items) out.push_back(v);
        return makeObj({{"success",JsonVal(true)},{"sorted",makeArr(out)}});
    }

    // ── knapsack ───────────────────────────────────────────────────────────
    if (cmd == "knapsack") {
        const auto& itemsV  = req.get("items");
        double maxW         = req.get("max_weight_kg").asDouble();
        if (maxW <= 0) maxW = 100;
        std::vector<double> weights;
        std::vector<int>    utilities;
        std::vector<JsonVal> itemList;
        if (itemsV.type == JsonVal::ARR) {
            for (auto& itm : itemsV.arr) {
                weights.push_back(itm.get("weight_per_unit").asDouble());
                utilities.push_back(itm.get("utility_value").asInt());
                itemList.push_back(itm);
            }
        }
        auto res = knapsack01(weights, utilities, maxW);
        JsonArr selected;
        for (int i : res.selectedIndices) selected.push_back(itemList[i]);
        return makeObj({{"success",JsonVal(true)},
                        {"total_utility",JsonVal((double)res.totalUtility)},
                        {"selected",makeArr(selected)}});
    }

    // ── greedy_tsp ─────────────────────────────────────────────────────────
    if (cmd == "greedy_tsp") {
        std::string depotId  = req.get("depot_id").asStr();
        double depotLat      = req.get("depot_lat").asDouble();
        double depotLng      = req.get("depot_lng").asDouble();
        const auto& hospsV   = req.get("hospitals");
        std::vector<std::tuple<std::string,double,double>> hosps;
        if (hospsV.type == JsonVal::ARR) {
            for (auto& h : hospsV.arr)
                hosps.push_back({h.get("id").asStr(), h.get("lat").asDouble(), h.get("lng").asDouble()});
        }
        auto res = greedyTSP(depotId, depotLat, depotLng, hosps);
        JsonArr ra; for (auto& r:res.route) ra.push_back(JsonVal(r));
        return makeObj({{"success",JsonVal(true)},{"route",makeArr(ra)},
                        {"total_dist_km",JsonVal(res.totalDistKm)}});
    }

    // ── ford_fulkerson ─────────────────────────────────────────────────────
    if (cmd == "ford_fulkerson") {
        std::string src  = req.get("source").asStr();
        std::string sink = req.get("sink").asStr();
        const auto& gV   = req.get("graph");
        std::vector<std::string> nodes;
        std::unordered_map<std::string,std::unordered_map<std::string,int>> cap;
        if (gV.type == JsonVal::OBJ) {
            for (auto& [u,adj] : gV.obj) {
                nodes.push_back(u);
                if (adj.type != JsonVal::ARR) continue;
                for (auto& edge : adj.arr) {
                    if (edge.type==JsonVal::ARR && edge.arr.size()>=2) {
                        std::string v = edge.arr[0].asStr();
                        int c = edge.arr[1].asInt();
                        cap[u][v] += c;
                        if (!cap.count(v)) nodes.push_back(v);
                    }
                }
            }
        }
        // Deduplicate nodes
        std::sort(nodes.begin(),nodes.end()); nodes.erase(std::unique(nodes.begin(),nodes.end()),nodes.end());
        auto res = fordFulkerson(nodes, cap, src, sink);
        JsonArr pathsArr;
        for (auto& [p,f] : res.paths) {
            JsonArr pa; for (auto& n:p) pa.push_back(JsonVal(n));
            pathsArr.push_back(makeObj({{"path",makeArr(pa)},{"flow",JsonVal((double)f)}}));
        }
        return makeObj({{"success",JsonVal(true)},{"max_flow",JsonVal((double)res.maxFlow)},{"paths",makeArr(pathsArr)}});
    }

    // ── gale_shapley ───────────────────────────────────────────────────────
    if (cmd == "gale_shapley") {
        const auto& pV = req.get("patients");
        const auto& dV = req.get("doctors");
        std::vector<std::pair<std::string,std::vector<std::string>>> patients;
        std::vector<std::tuple<std::string,std::vector<std::string>,int>> doctors;
        if (pV.type==JsonVal::ARR) {
            for (auto& p : pV.arr) {
                std::string pid = p.get("id").asStr();
                std::vector<std::string> prefs;
                if (p.get("preferences").type==JsonVal::ARR)
                    for (auto& pr : p.get("preferences").arr) prefs.push_back(pr.asStr());
                patients.push_back({pid,prefs});
            }
        }
        if (dV.type==JsonVal::ARR) {
            for (auto& d : dV.arr) {
                std::string did = d.get("id").asStr();
                int cap = d.get("capacity").asInt(); if (cap<=0) cap=1;
                std::vector<std::string> prefs;
                if (d.get("preferences").type==JsonVal::ARR)
                    for (auto& pr : d.get("preferences").arr) prefs.push_back(pr.asStr());
                doctors.push_back({did,prefs,cap});
            }
        }
        auto matching = galeShapley(patients, doctors);
        JsonObj mObj;
        for (auto& [p,d] : matching) mObj[p] = JsonVal(d);
        return makeObj({{"success",JsonVal(true)},{"matching",JsonVal(std::move(mObj))}});
    }

    return makeObj({{"success",JsonVal(false)},{"error",JsonVal("Unknown command: "+cmd)}});
}

// ─────────────────────────────────────────────────────────────────────────────
// main — read JSON from stdin, write result to stdout
// ─────────────────────────────────────────────────────────────────────────────
int main() {
    std::string line, input;
    while (std::getline(std::cin, line)) input += line + "\n";
    if (input.empty()) {
        std::cout << "{\"success\":false,\"error\":\"No input\"}" << std::endl;
        return 1;
    }
    try {
        JsonVal req = parseJSON(input);
        JsonVal res = dispatch(req);
        std::cout << toJSON(res) << std::endl;
    } catch (std::exception& e) {
        std::cout << "{\"success\":false,\"error\":\"" << e.what() << "\"}" << std::endl;
        return 1;
    }
    return 0;
}
