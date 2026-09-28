/* Sonic Atlas: the player side (README.md explains the idea).

   Every mapped song is a star. Left to right is calm to intense, bottom to top is dark to bright, and its colour is its
   key on the Camelot wheel. Drag to look around, scroll or pinch to zoom, click a star to hear it. In journey mode,
   draw a line: the songs along it become a playlist, each chosen to follow the one before in key and tempo, the way
   a DJ mixes. */
Axdio.plugin('atlas', atlas => {
  'use strict';
  const AX = atlas.AX, L = AX.L, U = AX.U, esc = atlas.esc;
  const ic = (n, c) => atlas.icon(n, c);
  const nf = n => Number(n).toLocaleString();
  const KEYS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const A = { data: null, loading: null, stars: [], byRel: new Map(), groups: [], grid: null, G: 48, trail: true, page: null };
  const card = { label: 'Sonic Atlas', title: 'Draw a journey', sub: 'Your library, mapped by how it sounds', icon: 'compass',
                 color: 'radial-gradient(circle at 80% 20%, #7c3aed 0%, transparent 55%), radial-gradient(circle at 15% 90%, #0ea5e9 0%, transparent 50%), #0b1026',
                 run: () => atlas.go('map') };

  // ---------- Keys on the Camelot wheel ----------
  const camNum = c => ((c - 1) % 12) + 1;
  const camMajor = c => c > 12;
  const camName = c => `${camNum(c)}${camMajor(c) ? 'B' : 'A'}`;
  function keyName(c) {
    const rel = (((camNum(c) - 8) * 7) % 12 + 12) % 12;            // the major key with that number
    return camMajor(c) ? `${KEYS[rel]} major` : `${KEYS[(rel + 9) % 12]} minor`;
  }
  const COLORS = Array.from({ length: 25 }, (_, c) => c ? `hsl(${(camNum(c) * 30 + 150) % 360}, ${camMajor(c) ? 85 : 72}%, ${camMajor(c) ? 68 : 58}%)` : '#fff');
  function galaxy(x, y) {                                            // the square of ranks, folded into a round sky, denser in the middle
    const a = 2 * x - 1, b = 2 * y - 1;
    if (!a && !b) return [0.5, 0.5];
    let r, phi;                                                       // Shirley–Chiu: neighbours stay neighbours, sides stay sides
    if (Math.abs(a) > Math.abs(b)) { r = a; phi = (Math.PI / 4) * (b / a); }
    else { r = b; phi = Math.PI / 2 - (Math.PI / 4) * (a / b); }
    const k = Math.pow(Math.abs(r), 1.35) * Math.sign(r) * 0.47;
    return [0.5 + k * Math.cos(phi), 0.5 + k * Math.sin(phi)];
  }
  let GLOWS = null;                                                   // a soft halo per colour, drawn behind the stars
  function glows() {
    if (GLOWS) return GLOWS;
    GLOWS = COLORS.map(color => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, color); g.addColorStop(0.25, color); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.globalAlpha = 0.5; x.fillRect(0, 0, 64, 64);
      return c;
    });
    return GLOWS;
  }
  function camStep(a, b) {                                          // 0 = the same key, about 0.25 = mixes well, 1+ = clashes
    if (a.cam === b.cam) return 0;
    const d = Math.min((a.num - b.num + 12) % 12, (b.num - a.num + 12) % 12);
    if (a.major === b.major) return d === 1 ? 0.25 : 0.5 + d * 0.12;
    return d === 0 ? 0.25 : d === 1 ? 0.6 : 0.8 + d * 0.12;
  }
  function tempoStep(a, b) {                                        // half and double time count as the same
    let r = Math.abs(Math.log2((b || 120) / (a || 120)));
    r = Math.min(r, Math.abs(r - 1));
    return Math.min(1, r * 5);
  }

  // ---------- The map's data ----------
  async function load() {
    if (A.loading) return A.loading;
    A.loading = (async () => {
      const headers = U.token ? { 'X-Auth-Token': U.token } : {};
      const res = await fetch('/api/plugins/atlas/map', { headers });      // revalidated with its ETag, so usually tiny
      if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to see the Sonic Atlas.' : `The map couldn't be loaded (${res.status}).`);
      build(await res.json());
      A.at = Date.now();
    })().finally(() => { A.loading = null; });
    return A.loading;
  }
  function build(d) {
    const plays = new Map((U.history || []).map(h => [h.rel_path, h.count || 1]));
    const stars = [], byRel = new Map();
    for (const [rel, x, y, bpm, cam, e, m, v] of d.songs) {
      const t = L.byRel.get(rel);
      if (!t) continue;
      const al = L.albums[t.albumId];
      const [gx, gy] = galaxy(x / 10000, y / 10000);
      const s = { i: stars.length, t, rel, x: gx, y: gy, bpm, cam, num: camNum(cam), major: camMajor(cam), e, m, v,
                  artist: String(t.artist || '').toLowerCase(), album: al ? al.title : '', plays: plays.get(rel) || 0 };
      s.text = `${t.title} ${t.artist} ${s.album}`.toLowerCase();
      stars.push(s); byRel.set(rel, s);
    }
    const G = A.G, grid = Array.from({ length: G * G }, () => []), groups = Array.from({ length: 25 }, () => []);
    for (const s of stars) { grid[cell(s.x) * G + cell(s.y)].push(s); groups[s.cam].push(s); }
    Object.assign(A, { data: d, stars, byRel, grid, groups });
    card.sub = stars.length ? `${nf(stars.length)} songs mapped by how they sound` : 'Your library, mapped by how it sounds';
  }
  const cell = v => Math.max(0, Math.min(A.G - 1, Math.floor(v * A.G)));
  // Stars near a point (map units), nearest first, skipping `skip`.
  function near(x, y, want, skip) {
    const G = A.G, cx = cell(x), cy = cell(y), out = [];
    for (let r = 0; r < G; r++) {
      for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
        if (i < 0 || j < 0 || i >= G || j >= G || (Math.abs(i - cx) !== r && Math.abs(j - cy) !== r)) continue;
        for (const s of A.grid[i * G + j]) if (!skip || !skip.has(s)) out.push(s);
      }
      if (out.length >= want && r > 0) break;
    }
    out.forEach(s => { s.d = Math.hypot(s.x - x, s.y - y); });
    return out.sort((a, b) => a.d - b.d).slice(0, want);
  }

  // ---------- Journeys and sonic twins ----------
  function resample(path, n) {
    const seg = [0];
    for (let i = 1; i < path.length; i++) seg.push(seg[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    const total = seg[seg.length - 1], out = [];
    for (let k = 0; k < n; k++) {
      const at = n === 1 ? 0 : total * k / (n - 1);
      let i = 1;
      while (i < seg.length - 1 && seg[i] < at) i++;
      const f = seg[i] > seg[i - 1] ? (at - seg[i - 1]) / (seg[i] - seg[i - 1]) : 0;
      const dx = path[i][0] - path[i - 1][0], dy = path[i][1] - path[i - 1][1], len = Math.hypot(dx, dy) || 1;
      // where on the line it is, and which way the line goes there
      out.push({ x: path[i - 1][0] + dx * f, y: path[i - 1][1] + dy * f, at, tx: dx / len, ty: dy / len });
    }
    return { points: out, length: total };
  }
  const pathLength = path => path.reduce((sum, p, i) => i ? sum + Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : 0, 0);
  const defaultCount = path => Math.max(10, Math.min(40, Math.round(8 + pathLength(path) * 26)));
  function journey(path, count) {
    const { points, length } = resample(path, count);
    const spacing = Math.max(0.01, length / Math.max(1, count - 1));
    const used = new Set(), out = [], lastArtists = [];
    let lastAt = -Infinity;
    for (const p of points) {
      let best = null, bestCost = Infinity, bestAt = 0;
      const prev = out[out.length - 1];
      for (const s of near(p.x, p.y, 28, used)) {
        let cost = s.d / spacing;
        // Where the song sits along the line: going back the way the line came costs extra (lines that loop back on
        // themselves would otherwise hop between their two sides).
        const at = p.at + ((s.x - p.x) * p.tx + (s.y - p.y) * p.ty);
        if (at < lastAt) cost += 1.5 * (lastAt - at) / spacing;
        if (prev) cost += 0.55 * camStep(prev, s) + 0.45 * tempoStep(prev.bpm, s.bpm);
        if (lastArtists.includes(s.artist)) cost += s.artist === lastArtists[lastArtists.length - 1] ? 0.9 : 0.35;
        if (cost < bestCost) { bestCost = cost; best = s; bestAt = at; }
      }
      if (!best) break;
      used.add(best); out.push(best); lastAt = bestAt;
      lastArtists.push(best.artist); if (lastArtists.length > 3) lastArtists.shift();
    }
    return out;
  }
  function twins(seed, n = 25) {
    const dist = (a, b) => { let d = 0; for (let k = 0; k < 8; k++) { const x = (a.v[k] - b.v[k]) / 30; d += x * x; } return Math.sqrt(d); };
    const pool = A.stars.filter(s => s !== seed)
      .map(s => ({ s, c: dist(seed, s) + 0.5 * camStep(seed, s) + 0.4 * tempoStep(seed.bpm, s.bpm) + (s.artist === seed.artist ? 0.3 : 0) }))
      .sort((a, b) => a.c - b.c).slice(0, n * 2).map(o => o.s);
    const out = [seed], left = new Set(pool);
    while (out.length < n && left.size) {                            // each next song is the closest to the last one
      const last = out[out.length - 1];
      let best = null, bc = Infinity;
      for (const s of left) { const c = dist(last, s) + 0.5 * camStep(last, s) + 0.4 * tempoStep(last.bpm, s.bpm) + (s.artist === last.artist ? 0.6 : 0); if (c < bc) { bc = c; best = s; } }
      left.delete(best); out.push(best);
    }
    return out;
  }
  const PRESETS = [
    { name: 'Warm up', sub: 'From calm to full energy', path: [[.08, .45], [.35, .52], [.65, .6], [.93, .68]] },
    { name: 'Wind down', sub: 'From intense to calm', path: [[.93, .6], [.62, .5], [.32, .4], [.07, .3]] },
    { name: 'Peak and back', sub: 'Build up, peak, cool down', path: [[.1, .32], [.45, .6], [.9, .82], [.55, .55], [.12, .28]] },
    { name: 'Sunrise', sub: 'Dark and slow to bright and lively', path: [[.12, .08], [.35, .35], [.62, .65], [.88, .93]] },
    { name: 'Night drive', sub: 'Moody, with steady momentum', path: [[.35, .14], [.5, .22], [.66, .18], [.82, .26]] },
    { name: 'Daydream', sub: 'Soft, bright and floating', path: [[.06, .7], [.2, .88], [.36, .74], [.48, .9]] },
  ];
  const describe = list => {
    const bpms = list.map(s => s.bpm).filter(Boolean);
    return list.length ? `${list.length} songs · ${bpms[0]} → ${bpms[bpms.length - 1]} BPM · ${camName(list[0].cam)} → ${camName(list[list.length - 1].cam)}` : '';
  };
  function playList(list, name) {
    if (!list.length) return;
    const ids = list.map(s => s.t.id);
    AX.playCtx(AX.makeCtx('plugin', 'atlas:' + Date.now(), name || 'Sonic Atlas', ids), 0);
  }
  async function ensure() {
    if (!A.data) await load();
    return A.stars.length;
  }

  // ---------- The page ----------
  atlas.page('map', {
    title: 'Sonic Atlas',
    icon: 'compass',
    render(el, params) {
      const P = A.page = { el, view: { cx: 0.5, cy: 0.5, z: 1 }, dirty: true, mode: 'look', path: null, route: [], count: 0, sel: null, hover: null,
                           match: null, liked: false, pointers: new Map(), raf: 0, timers: [], off: [] };
      el.innerHTML = `<div class="atl">
        <canvas class="atl-cv" aria-label="A map of the songs in your library"></canvas>
        <div class="atl-top">
          <div class="atl-title"><b>Sonic Atlas</b><span class="atl-count"></span></div>
          <div class="atl-tools">
            <label class="atl-search">${ic('search', 'sm')}<input type="search" placeholder="Find an artist, song or album" aria-label="Find on the map" spellcheck="false"></label>
            <button class="atl-btn" data-a="draw" title="Draw a line across the map, and hear the songs along it">${ic('edit', 'sm')}<span>Draw a journey</span></button>
            <button class="atl-btn" data-a="presets" title="Journeys to start from">${ic('spark', 'sm')}<span>Autopilot</span></button>
            <button class="atl-btn" data-a="liked" title="Show the songs you like">${ic('heart', 'sm')}<span>Liked</span></button>
            <button class="atl-btn icon" data-a="home" title="See the whole map" aria-label="See the whole map">${ic('expand', 'sm')}</button>
          </div>
        </div>
        <div class="atl-hint" hidden></div>
        <div class="atl-menu" hidden></div>
        <div class="atl-tip" hidden></div>
        <div class="atl-card" hidden></div>
        <div class="atl-bar" hidden></div>
        <div class="atl-status" hidden></div>
        <div class="atl-empty" hidden></div>
      </div>`;
      const root = el.firstElementChild, cv = root.querySelector('.atl-cv'), out = cv.getContext('2d');
      const base = document.createElement('canvas'), ctx = base.getContext('2d');   // the map itself, redrawn only when it changes
      const $ = s => root.querySelector(s);
      let W = 0, H = 0, dpr = 1;

      // Size: the rest of the window, above the player bar (desktop) or the mini player and tabs (phones).
      let fitted = '';
      function fit() {
        const top = root.getBoundingClientRect().top;
        if (!root.offsetWidth) return;                                   // hidden (a phone builds pages before showing them)
        let bottom = innerHeight;
        if (atlas.platform === 'mobile') {
          for (const id of ['mini', 'nav']) {                              // fixed at the bottom, when they're showing
            const n = document.getElementById(id), r = n && n.getBoundingClientRect();
            if (r && r.height > 0 && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden') bottom = Math.min(bottom, r.top);
          }
        } else {
          const main = document.getElementById('main');
          if (main) bottom = Math.min(bottom, main.getBoundingClientRect().bottom - 18);
        }
        root.style.height = Math.max(360, Math.round(bottom - top - 6)) + 'px';
        dpr = Math.min(2, devicePixelRatio || 1);
        W = cv.clientWidth; H = cv.clientHeight;
        cv.width = base.width = Math.round(W * dpr); cv.height = base.height = Math.round(H * dpr);
        fitted = `${Math.round(root.getBoundingClientRect().top)}:${innerWidth}:${innerHeight}`;
        P.dirty = true;
      }
      let lastCheck = 0;
      function checkFit(now) {                                           // a few times a second: has the page moved?
        if (now - lastCheck < 250) return;
        lastCheck = now;
        if (!root.offsetWidth) return;
        if (`${Math.round(root.getBoundingClientRect().top)}:${innerWidth}:${innerHeight}` !== fitted || !W || !H) fit();
      }

      // Map <-> screen. y goes up on the map (bright is on top).
      const pad = () => Math.min(56, Math.max(24, Math.min(W, H) * 0.07));
      const toX = x => W / 2 + (x - P.view.cx) * (W - 2 * pad()) * P.view.z;
      const toY = y => H / 2 - (y - P.view.cy) * (H - 2 * pad()) * P.view.z;
      const fromX = px => P.view.cx + (px - W / 2) / ((W - 2 * pad()) * P.view.z);
      const fromY = py => P.view.cy - (py - H / 2) / ((H - 2 * pad()) * P.view.z);
      function zoomAt(px, py, f) {
        const mx = fromX(px), my = fromY(py);
        P.view.z = Math.max(0.8, Math.min(60, P.view.z * f));
        P.view.cx = mx - (px - W / 2) / ((W - 2 * pad()) * P.view.z);
        P.view.cy = my + (py - H / 2) / ((H - 2 * pad()) * P.view.z);
        clampView(); P.dirty = true;
      }
      function clampView() {
        const m = 0.6 / P.view.z;                                     // keep some of the map in view
        P.view.cx = Math.max(-m, Math.min(1 + m, P.view.cx));
        P.view.cy = Math.max(-m, Math.min(1 + m, P.view.cy));
      }
      function flyTo(x, y, z, ms = 650) {
        const from = { ...P.view }, t0 = performance.now();
        const step = now => {
          if (!A.page || A.page !== P) return;
          const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          P.view.cx = from.cx + (x - from.cx) * e; P.view.cy = from.cy + (y - from.cy) * e;
          P.view.z = Math.exp(Math.log(from.z) + (Math.log(z) - Math.log(from.z)) * e);
          P.dirty = true;
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      function fitTo(list) {
        if (!list.length) return;
        let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
        list.forEach(s => { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); });
        const z = Math.max(1, Math.min(12, 0.8 / Math.max(x1 - x0, y1 - y0, 0.05)));
        flyTo((x0 + x1) / 2, (y0 + y1) / 2, z);
      }

      // ---------- Drawing ----------
      const QUADS = [[.25, .78, 'Dreamy'], [.75, .78, 'Euphoric'], [.25, .22, 'Melancholic'], [.75, .22, 'Fierce']];
      function draw() {
        P.baseView = { ...P.view };
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const g = ctx.createRadialGradient(W * .5, H * .45, 0, W * .5, H * .5, Math.max(W, H) * .75);
        g.addColorStop(0, '#111735'); g.addColorStop(.55, '#080b1c'); g.addColorStop(1, '#03040b');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        // The four moods, and the axes.
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const [x, y, name] of QUADS) {
          const size = Math.max(18, Math.min(64, W * .045 * Math.sqrt(P.view.z)));
          ctx.font = `800 ${size}px system-ui, sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,.045)';
          ctx.fillText(name.toUpperCase(), toX(x), toY(y));
        }
        ctx.strokeStyle = 'rgba(160,180,255,.08)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(toX(.5), toY(-.05)); ctx.lineTo(toX(.5), toY(1.05)); ctx.moveTo(toX(-.05), toY(.5)); ctx.lineTo(toX(1.05), toY(.5)); ctx.stroke();
        ctx.font = '700 11px system-ui, sans-serif'; ctx.fillStyle = 'rgba(190,200,255,.42)';
        const top = $('.atl-top'), below = top ? top.offsetTop + top.offsetHeight + 12 : 16;   // under the toolbar
        ctx.fillText('BRIGHT', W / 2, below); ctx.fillText('DARK', W / 2, H - 14);
        ctx.save(); ctx.translate(14, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('CALM', 0, 0); ctx.restore();
        ctx.save(); ctx.translate(W - 14, H / 2); ctx.rotate(Math.PI / 2); ctx.fillText('INTENSE', 0, 0); ctx.restore();

        // Stars, a batch per colour: a soft glow, then the star. Lighter blending makes crowded parts shine.
        // Fewer songs, bigger stars: a small library still looks like a sky.
        const r0 = Math.max(0.75, Math.min(2.8, 4.4 - 0.95 * Math.log10(Math.max(10, A.stars.length))));
        const crowd = Math.min(1, Math.sqrt(600 / Math.max(600, A.stars.length)));   // thousands of halos would wash the colours out
        const zr = Math.min(3.2, Math.pow(P.view.z, 0.38));
        const dim = !!(P.match || P.liked);
        ctx.globalCompositeOperation = 'lighter';
        const halo = glows();
        const size = s => (r0 + Math.min(2.2, Math.log1p(s.plays) * 0.55)) * zr;
        ctx.globalAlpha = (dim ? 0.55 : 0.32) * (dim ? 1 : Math.max(0.35, crowd));
        for (const s of A.stars) {                                       // halos first, for the stars that are lit
          if (dim && !(P.match ? P.match.has(s) : liked(s))) continue;
          const x = toX(s.x), y = toY(s.y), R = size(s) * (3 + 1.5 * crowd);
          if (x < -R || y < -R || x > W + R || y > H + R) continue;
          ctx.drawImage(halo[s.cam], x - R, y - R, R * 2, R * 2);
        }
        for (let c = 1; c <= 24; c++) {
          for (const bright of dim ? [false, true] : [true]) {
            ctx.beginPath();
            let any = false;
            for (const s of A.groups[c] || []) {
              const on = !dim || (P.match ? P.match.has(s) : liked(s));
              if (on !== bright) continue;
              const x = toX(s.x), y = toY(s.y);
              if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue;
              const r = size(s) * (on && dim ? 1.35 : 1);
              ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.283); any = true;
            }
            if (!any) continue;
            ctx.globalAlpha = bright ? 0.6 + 0.35 * crowd : 0.13;
            ctx.fillStyle = COLORS[c]; ctx.fill();
          }
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

        // Where you've been listening.
        if (A.trail && !P.route.length) {
          const pts = (U.history || []).slice(0, 30).map(h => A.byRel.get(h.rel_path)).filter(Boolean).reverse();
          if (pts.length > 1) {
            ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 5]);
            ctx.beginPath(); pts.forEach((s, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, toX(s.x), toY(s.y))); ctx.stroke(); ctx.setLineDash([]);
          }
        }
        // The journey.
        if (P.route.length) {
          const grad = ctx.createLinearGradient(toX(P.route[0].x), toY(P.route[0].y), toX(P.route[P.route.length - 1].x), toY(P.route[P.route.length - 1].y));
          grad.addColorStop(0, '#5eead4'); grad.addColorStop(1, '#f0abfc');
          ctx.strokeStyle = grad; ctx.lineWidth = 2.5;
          ctx.beginPath(); P.route.forEach((s, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, toX(s.x), toY(s.y))); ctx.stroke();
          ctx.font = '700 10px system-ui, sans-serif';
          P.route.forEach((s, i) => {
            const x = toX(s.x), y = toY(s.y);
            ctx.fillStyle = '#0b1026'; ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.283); ctx.fill();
            ctx.strokeStyle = COLORS[s.cam]; ctx.lineWidth = 2; ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), x, y + .5);
          });
        }
      }
      // On top: the line being drawn, the song playing now (a pulse), and the one pointed at or chosen.
      function overlay(now) {
        const c = out, bv = P.baseView || P.view;
        c.setTransform(1, 0, 0, 1, 0, 0);
        if (bv.z === P.view.z && (bv.cx !== P.view.cx || bv.cy !== P.view.cy)) {
          // Being dragged: slide the picture of the map instead of drawing every star again.
          const dx = (bv.cx - P.view.cx) * (W - 2 * pad()) * P.view.z, dy = (P.view.cy - bv.cy) * (H - 2 * pad()) * P.view.z;
          c.fillStyle = '#05060f'; c.fillRect(0, 0, cv.width, cv.height);
          c.drawImage(base, Math.round(dx * dpr), Math.round(dy * dpr));
        } else c.drawImage(base, 0, 0);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (P.path && P.path.length > 1) {
          c.lineCap = c.lineJoin = 'round';
          c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 14;
          c.beginPath(); P.path.forEach(([x, y], i) => (i ? c.lineTo : c.moveTo).call(c, toX(x), toY(y))); c.stroke();
          c.strokeStyle = 'rgba(255,255,255,.6)'; c.lineWidth = 2; c.setLineDash([6, 6]); c.stroke(); c.setLineDash([]);
        }
        const cur = AX.curTrack && AX.curTrack(), cs = cur && A.byRel.get(cur.rel);
        if (cs) {
          const x = toX(cs.x), y = toY(cs.y), k = AX.isPlaying() ? (now / 1100) % 1 : 0.35;
          c.strokeStyle = `rgba(255,255,255,${0.9 - k * 0.85})`; c.lineWidth = 2;
          c.beginPath(); c.arc(x, y, 6 + k * 22, 0, 6.283); c.stroke();
          c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 3.5, 0, 6.283); c.fill();
        }
        for (const [s, color] of [[P.hover, 'rgba(255,255,255,.7)'], [P.sel, '#fff']]) {
          if (!s) continue;
          c.strokeStyle = color; c.lineWidth = 2;
          c.beginPath(); c.arc(toX(s.x), toY(s.y), 9, 0, 6.283); c.stroke();
        }
      }
      const liked = s => U.likedSet && U.likedSet.has(s.rel);
      let lastFrame = 0;
      function loop(now) {
        if (A.page !== P) return;
        P.raf = requestAnimationFrame(loop);
        checkFit(now);
        if (!W || !H) return;
        const cur = AX.curTrack && AX.curTrack();
        const pulsing = cur && AX.isPlaying() && A.byRel.has(cur.rel);
        if (!P.dirty && !P.moving && !(pulsing && now - lastFrame > 33)) return;   // the pulse runs at 30 frames a second
        lastFrame = now;
        if (P.dirty) { P.dirty = false; draw(); }
        overlay(now);
        P.moving = false;
      }

      // ---------- Overlays ----------
      function status() {
        const d = A.data;
        $('.atl-count').textContent = d ? `${nf(A.stars.length)} of ${nf(d.library)} songs` : '';
        const st = $('.atl-status');
        if (d && d.count < d.library) {
          const pct = Math.floor(100 * d.count / Math.max(1, d.library));
          st.hidden = false;
          st.innerHTML = `<b>${d.paused ? 'Mapping is paused' : 'Mapping your library'}</b> · ${nf(d.count)} of ${nf(d.library)} songs (${pct}%)${d.paused ? '' : '. New stars appear as songs are listened to.'}<i style="--p:${pct}%"></i>`;
        } else st.hidden = true;
        const empty = $('.atl-empty');
        empty.hidden = !!A.stars.length;
        if (!A.stars.length) empty.innerHTML = `<div>${ic('compass')}<h2>Your map is being drawn</h2><p>Sonic Atlas listens to each song once (a minute of it, from about a third of the way in) and places it by how it sounds. Your server does this in the background: the first stars show up in a minute or two${d && d.library ? `, and all ${nf(d.library)} songs take about ${Math.max(1, Math.round(d.library * 7 / 3600))} hour${d.library * 7 / 3600 >= 1.5 ? 's' : ''}` : ''}.</p></div>`;
      }
      function hint(text) {
        const h = $('.atl-hint');
        h.hidden = !text; h.textContent = text || '';
      }
      function showCard(s) {
        P.sel = s; P.dirty = true;
        const c = $('.atl-card');
        if (!s) { c.hidden = true; return; }
        c.hidden = false;
        c.innerHTML = `<img src="${esc(AX.coverUrl(s.rel))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div class="atl-card-t"><b>${esc(s.t.title)}</b><span>${esc(s.t.artist)}${s.album ? ' · ' + esc(s.album) : ''}</span>
            <div class="atl-chips"><span>${s.bpm} BPM</span><span style="--k:${COLORS[s.cam]}">${camName(s.cam)} · ${keyName(s.cam)}</span><span>Energy ${s.e}%</span><span>Brightness ${s.m}%</span></div>
            <div class="atl-acts"><button class="atl-btn solid" data-a="play">${ic('play', 'sm')}Play</button><button class="atl-btn" data-a="twins">${ic('radio', 'sm')}Sonic twins</button><button class="atl-btn" data-a="from">${ic('edit', 'sm')}Journey from here</button></div></div>
          <button class="atl-x" data-a="unselect" aria-label="Close">${ic('close', 'sm')}</button>`;
      }
      function showRoute(route, path, name) {
        P.route = route; P.path = path; P.name = name || 'Your journey'; P.dirty = true;
        const b = $('.atl-bar');
        if (!route.length) { b.hidden = true; return; }
        b.hidden = false;
        b.innerHTML = `<div class="atl-bar-t"><b>${esc(P.name)}</b><span>${esc(describe(route))}</span></div>
          <div class="atl-acts"><span class="atl-len"><button class="atl-btn icon" data-a="fewer" aria-label="Fewer songs">${ic('minus-c', 'sm')}</button><button class="atl-btn icon" data-a="more" aria-label="More songs">${ic('add', 'sm')}</button></span>
          <button class="atl-btn solid" data-a="go">${ic('play', 'sm')}Play</button><button class="atl-btn" data-a="save">${ic('pl-add', 'sm')}Save</button><button class="atl-btn icon" data-a="clear" aria-label="Clear the journey">${ic('close', 'sm')}</button></div>`;
      }
      function makeJourney(path, name, count) {
        const route = journey(path, count || defaultCount(path));
        P.count = route.length;
        showRoute(route, path, name);
        if (!route.length) atlas.toast('No songs on the map yet');
      }
      function setMode(mode) {
        P.mode = mode;
        root.classList.toggle('drawing', mode === 'draw');
        $('[data-a="draw"]').classList.toggle('on', mode === 'draw');
        hint(mode === 'draw' ? 'Draw a line across the map: its songs become a journey' : '');
      }
      function presetsMenu() {
        const m = $('.atl-menu');
        if (!m.hidden) { m.hidden = true; return; }
        const cur = AX.curTrack && AX.curTrack(), cs = cur && A.byRel.get(cur.rel);
        m.innerHTML = PRESETS.map((p, i) => `<button data-a="preset" data-i="${i}"><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></button>`).join('')
          + (cs ? `<button data-a="preset-cur"><b>Somewhere new</b><span>From ${esc(cs.t.title)} to the other side of the map</span></button>` : '');
        m.hidden = false;
      }
      function applySearch(q) {
        q = q.trim().toLowerCase();
        P.match = q.length >= 2 ? new Set(A.stars.filter(s => s.text.includes(q))) : null;
        P.dirty = true;
        return P.match;
      }

      // ---------- Pointer: look around, pick a star, or draw ----------
      function pick(px, py, radius = 14) {
        let best = null, bd = radius * radius;
        const cands = near(fromX(px), fromY(py), 40);
        for (const s of cands) {
          const dx = toX(s.x) - px, dy = toY(s.y) - py, d = dx * dx + dy * dy;
          if (d < bd && (!P.match || P.match.has(s))) { bd = d; best = s; }
        }
        return best;
      }
      const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      let drag = null, pinch = null;
      cv.addEventListener('pointerdown', e => {
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not a real pointer (tests, some browsers) */ }
        const [x, y] = local(e);
        P.pointers.set(e.pointerId, [x, y]);
        $('.atl-menu').hidden = true;
        if (P.pointers.size === 2) {
          const [a, b] = [...P.pointers.values()];
          pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: P.view.z };
          drag = null; return;
        }
        drag = { x, y, cx: P.view.cx, cy: P.view.cy, moved: false, draw: P.mode === 'draw' };
        if (drag.draw) { P.path = [[fromX(x), fromY(y)]]; P.route = []; $('.atl-bar').hidden = true; }
      });
      cv.addEventListener('pointermove', e => {
        const [x, y] = local(e);
        if (P.pointers.has(e.pointerId)) P.pointers.set(e.pointerId, [x, y]);
        if (pinch && P.pointers.size === 2) {
          const [a, b] = [...P.pointers.values()];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.z * d / pinch.d) / P.view.z);
          return;
        }
        if (drag) {
          if (Math.hypot(x - drag.x, y - drag.y) > 4) drag.moved = true;
          if (drag.draw) {
            const last = P.path[P.path.length - 1], p = [fromX(x), fromY(y)];
            if (Math.hypot(toX(last[0]) - x, toY(last[1]) - y) > 3) { P.path.push(p); P.moving = true; }
          } else if (drag.moved) {
            P.view.cx = drag.cx - (x - drag.x) / ((W - 2 * pad()) * P.view.z);
            P.view.cy = drag.cy + (y - drag.y) / ((H - 2 * pad()) * P.view.z);
            clampView(); P.moving = true;
          }
          return;
        }
        if (e.pointerType === 'mouse') {
          const s = pick(x, y);
          if (s !== P.hover) { P.hover = s; P.moving = true; tip(s, x, y); }
          else if (s) tip(s, x, y);
          cv.style.cursor = s ? 'pointer' : P.mode === 'draw' ? 'crosshair' : 'grab';
        }
      });
      const end = e => {
        P.pointers.delete(e.pointerId);
        if (pinch) { if (P.pointers.size < 2) pinch = null; return; }
        if (!drag) return;
        const d = drag; drag = null; P.moving = true;
        if (!d.draw && d.moved) P.dirty = true;                          // done dragging: draw the stars where they now are
        const [x, y] = local(e);
        if (d.draw && d.moved && P.path && pathLength(P.path) > 0.03) { makeJourney(P.path, 'Your journey'); setMode('look'); return; }
        if (d.draw) P.path = null;
        if (!d.moved) { const s = pick(x, y, e.pointerType === 'mouse' ? 14 : 22); showCard(s); }
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => { if (P.hover) { P.hover = null; P.dirty = true; } tip(null); });
      cv.addEventListener('dblclick', e => { const [x, y] = local(e); const s = pick(x, y); if (s) AX.playTrackAlone(s.t.id); else zoomAt(x, y, 2); });
      cv.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = local(e); zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022))); }, { passive: false });
      function tip(s, x, y) {
        const t = $('.atl-tip');
        if (!s) { t.hidden = true; return; }
        t.hidden = false;
        t.innerHTML = `<b>${esc(s.t.title)}</b><span>${esc(s.t.artist)}</span><em>${s.bpm} BPM · <i style="background:${COLORS[s.cam]}"></i>${camName(s.cam)}</em>`;
        const tw = t.offsetWidth, th = t.offsetHeight;
        t.style.left = Math.min(W - tw - 8, x + 14) + 'px';
        t.style.top = Math.max(8, y - th - 10) + 'px';
      }

      // ---------- Buttons ----------
      root.addEventListener('click', async e => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        const a = b.dataset.a;
        if (a === 'draw') setMode(P.mode === 'draw' ? 'look' : 'draw');
        else if (a === 'presets') presetsMenu();
        else if (a === 'preset') { $('.atl-menu').hidden = true; const p = PRESETS[+b.dataset.i]; makeJourney(p.path, p.name); flyTo(.5, .5, 1); }
        else if (a === 'preset-cur') {
          $('.atl-menu').hidden = true;
          const cs = A.byRel.get(AX.curTrack().rel);
          const tx = 1 - cs.x, ty = 1 - cs.y;
          makeJourney([[cs.x, cs.y], [(cs.x + tx) / 2 + (cs.y - ty) * .2, (cs.y + ty) / 2 + (tx - cs.x) * .2], [tx, ty]], 'Somewhere new');
        }
        else if (a === 'liked') { P.liked = !P.liked; b.classList.toggle('on', P.liked); P.dirty = true; if (P.liked) { const l = A.stars.filter(liked); if (!l.length) atlas.toast('Like some songs to see them here'); else fitTo(l); } }
        else if (a === 'home') flyTo(.5, .5, 1);
        else if (a === 'unselect') showCard(null);
        else if (a === 'play' && P.sel) AX.playTrackAlone(P.sel.t.id);
        else if (a === 'twins' && P.sel) { const list = twins(P.sel); showRoute(list, null, `Sonic twins of ${P.sel.t.title}`); playList(list, `Sonic twins of ${P.sel.t.title}`); }
        else if (a === 'from' && P.sel) { setMode('draw'); P.startAt = P.sel; hint('Now draw from the song: its line becomes a journey'); }
        else if (a === 'go') playList(P.route, P.name);
        else if (a === 'fewer' || a === 'more') {
          const n = Math.max(5, Math.min(80, P.route.length + (a === 'more' ? 5 : -5)));
          if (P.path) makeJourney(P.path, P.name, n);
          else if (P.route.length) { const list = twins(P.route[0], n); showRoute(list, null, P.name); }
        }
        else if (a === 'save') {
          const bar = $('.atl-bar');
          bar.innerHTML = `<form class="atl-save"><input maxlength="80" aria-label="Playlist name" value="${esc(`${P.name} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)}">
            <button class="atl-btn solid" type="submit">${ic('pl-add', 'sm')}Save as playlist</button><button class="atl-btn icon" type="button" data-a="unsave" aria-label="Cancel">${ic('close', 'sm')}</button></form>`;
          const f = bar.querySelector('form'), field = f.querySelector('input');
          field.focus(); field.select();
          field.addEventListener('keydown', ev => ev.stopPropagation());
          f.addEventListener('submit', ev => {
            ev.preventDefault();
            const err = AX.plCreate(field.value, P.route.map(x => x.t.id));
            if (err) { atlas.toast(err); return; }
            atlas.toast(`Saved as "${field.value.trim()}"`);
            showRoute(P.route, P.path, P.name);
          });
        }
        else if (a === 'unsave') showRoute(P.route, P.path, P.name);
        else if (a === 'clear') { showRoute([], null); }
      });
      const input = $('.atl-search input');
      input.addEventListener('input', () => applySearch(input.value));
      input.addEventListener('keydown', e => {
        e.stopPropagation();                                              // the player's own shortcuts stay out of the way
        if (e.key === 'Enter') { const m = applySearch(input.value); if (m && m.size) fitTo([...m]); else if (m) atlas.toast('Nothing on the map matches that'); }
        if (e.key === 'Escape') { input.value = ''; applySearch(''); input.blur(); }
      });
      const onKey = e => {
        if (A.page !== P || e.target.closest('input, textarea')) return;
        if (e.key === 'Escape') { if (P.mode === 'draw') setMode('look'); else if (P.sel) showCard(null); else if (P.route.length) showRoute([], null); }
      };
      document.addEventListener('keydown', onKey);
      // Journeys drawn from a chosen song start at it.
      cv.addEventListener('pointerdown', () => { if (P.mode === 'draw' && P.startAt && P.path) { P.path.unshift([P.startAt.x, P.startAt.y]); P.startAt = null; } });

      // ---------- Start ----------
      const onResize = () => fit();
      addEventListener('resize', onResize);
      const offTrack = atlas.on('track', () => { P.dirty = true; });
      const offLike = atlas.on('like', () => { P.dirty = true; });
      fit();
      P.raf = requestAnimationFrame(loop);
      const refresh = async () => {
        try { await load(); } catch (e) { $('.atl-empty').hidden = false; $('.atl-empty').innerHTML = `<div><h2>The map isn't available</h2><p>${esc(e.message)}</p></div>`; return; }
        if (A.page !== P) return;
        // Keep what's on screen when new stars arrive.
        if (P.sel) P.sel = A.byRel.get(P.sel.rel) || null;
        if (P.route.length) P.route = P.route.map(s => A.byRel.get(s.rel)).filter(Boolean);
        if (P.match) applySearch(input.value);
        status(); P.dirty = true;
        const focus = params && params.song && A.byRel.get(params.song);
        if (focus && !P.focused) { P.focused = true; showCard(focus); flyTo(focus.x, focus.y, 5); }
      };
      refresh();
      P.timers.push(setInterval(() => { if (!document.hidden && A.data && A.data.count < A.data.library) refresh(); }, 45000));
      requestAnimationFrame(fit);                                          // once the page has its final layout
      return () => {
        cancelAnimationFrame(P.raf); P.timers.forEach(clearInterval);
        removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey);
        offTrack(); offLike();
        if (A.page === P) A.page = null;
      };
    },
  });

  // ---------- Around the player ----------
  atlas.homeCard(card);
  atlas.menu({ label: 'Sonic Atlas', icon: 'compass', run: () => atlas.go('map') });
  atlas.trackAction({
    label: 'Sonic twins', icon: 'radio',
    when: songs => songs.length === 1,
    run: async songs => {
      try { await ensure(); } catch (e) { atlas.toast(e.message); return; }
      const s = A.byRel.get(songs[0].rel);
      if (!s) { atlas.toast("This song isn't on the Sonic Atlas yet"); return; }
      const list = twins(s);
      playList(list, `Sonic twins of ${s.t.title}`);
      atlas.toast(`Playing ${list.length - 1} songs that sound like ${s.t.title}`);
    },
  });
  atlas.trackAction({ label: 'Show on the Sonic Atlas', icon: 'compass', when: songs => songs.length === 1, run: songs => atlas.go('map', { song: songs[0].rel }) });
  atlas.store.get('trail').then(v => { if (v === false) A.trail = false; }).catch(() => {});
  atlas.settings({
    title: 'Sonic Atlas',
    render(el) {
      el.appendChild(atlas.row({ title: 'Show my listening trail', sub: 'A faint line through the last songs you played', toggle: A.trail,
        onChange: on => { A.trail = on; atlas.store.set('trail', on).catch(() => {}); if (A.page) A.page.dirty = true; } }));
    },
  });
  load().catch(() => {});                                                  // so the home card can say how many songs are mapped
});
