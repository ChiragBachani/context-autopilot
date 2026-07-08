/**
 * Local dashboard — the ambient observer's face. A zero-dependency HTTP
 * server bound to 127.0.0.1 only; nothing is hosted, nothing leaves the
 * machine. Runs inside the observer daemon and standalone via
 * `ctxlayer dashboard`.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambientRoot, loadConfig, pauseFor, saveConfig, setEnabled } from './config.js';
import {
  dayKey,
  deleteCapturedData,
  estimateObservedMinutes,
  listDays,
  readDay,
  screenshotStats,
} from './records.js';
import { launchAopInTerminal, observerAlive } from './observer.js';
import { narrateDay, summarizeDayFromDisk } from './summarize.js';
import { applyWorkflowDecisions, loadAops, loadWorkflowProposals, setAopEnabled } from './workflows.js';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function statusPayload(): Record<string, unknown> {
  const config = loadConfig();
  const day = dayKey();
  const records = readDay(day);
  const apps = [...new Set(records.map((r) => r.app))];
  const proposals = loadWorkflowProposals();
  const pending = proposals?.proposals.filter((p) => p.status === 'pending').length ?? 0;
  return {
    enabled: config.enabled,
    pausedUntil: config.pausedUntil ?? null,
    textOnly: config.textOnly,
    retentionDays: config.retentionDays,
    blocklistApps: config.blocklistApps,
    blocklistTitleKeywords: config.blocklistTitleKeywords,
    observing: observerAlive(),
    demo: Boolean(process.env.CTXLAYER_HOME),
    day,
    momentsToday: records.length,
    observedMinutes: estimateObservedMinutes(records),
    appsToday: apps,
    pendingProposals: pending,
    screenshots: screenshotStats(),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && path === '/api/status') return json(res, statusPayload());
    if (req.method === 'GET' && path === '/api/summary') {
      return json(res, summarizeDayFromDisk(dayKey()));
    }
    if (req.method === 'POST' && path === '/api/summary/narrate') {
      const summary = summarizeDayFromDisk(dayKey());
      try {
        return json(res, { narrative: await narrateDay(summary) });
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    if (req.method === 'GET' && path === '/api/days') return json(res, listDays());
    if (req.method === 'GET' && path === '/api/day') {
      const day = url.searchParams.get('d') ?? dayKey();
      return json(res, { day, records: readDay(day).slice(-500).reverse() });
    }
    if (req.method === 'GET' && path.startsWith('/shot/')) {
      // /shot/YYYY-MM-DD/filename — served from the ambient root only.
      const rel = normalize(path.slice('/shot/'.length));
      if (rel.includes('..') || !/^\d{4}-\d{2}-\d{2}\//.test(rel)) return json(res, { error: 'bad path' }, 400);
      const file = join(ambientRoot(), rel);
      if (!existsSync(file)) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': rel.endsWith('.png') ? 'image/png' : 'image/jpeg' });
      res.end(readFileSync(file));
      return;
    }
    if (req.method === 'GET' && path === '/api/proposals') {
      const file = loadWorkflowProposals();
      return json(res, file?.proposals ?? []);
    }
    if (req.method === 'POST' && path === '/api/proposals/decide') {
      const body = await readBody(req);
      const accept = Array.isArray(body.accept) ? (body.accept as string[]) : [];
      const reject = Array.isArray(body.reject) ? (body.reject as string[]) : [];
      return json(res, applyWorkflowDecisions(accept, reject));
    }
    if (req.method === 'GET' && path === '/api/aops') return json(res, loadAops());
    if (req.method === 'POST' && path === '/api/aops/toggle') {
      const body = await readBody(req);
      const aop = setAopEnabled(String(body.slug ?? ''), Boolean(body.enabled));
      return json(res, aop ?? { error: 'not found' }, aop ? 200 : 404);
    }
    if (req.method === 'POST' && path === '/api/aops/run') {
      const body = await readBody(req);
      const aop = loadAops().find((a) => a.slug === body.slug);
      if (!aop) return json(res, { error: 'not found' }, 404);
      launchAopInTerminal(aop);
      return json(res, { launched: aop.slug });
    }
    if (req.method === 'POST' && path === '/api/distill') {
      return json(res, startManualDistill());
    }
    if (req.method === 'GET' && path === '/api/distill/status') {
      return json(res, {
        running: distillChildRunning,
        lastFinishedAt: distillLastFinishedAt,
        proposalsGeneratedAt: loadWorkflowProposals()?.generatedAt ?? null,
      });
    }
    if (req.method === 'POST' && path === '/api/control') {
      const body = await readBody(req);
      if (body.action === 'on') return json(res, { config: setEnabled(true) });
      if (body.action === 'off') return json(res, { config: setEnabled(false) });
      if (body.action === 'pause') return json(res, { config: pauseFor(Number(body.minutes ?? 30)) });
      return json(res, { error: 'unknown action' }, 400);
    }
    if (req.method === 'POST' && path === '/api/config') {
      const body = await readBody(req);
      const config = loadConfig();
      if (typeof body.textOnly === 'boolean') config.textOnly = body.textOnly;
      if (Array.isArray(body.blocklistApps)) config.blocklistApps = (body.blocklistApps as string[]).filter(Boolean);
      if (Array.isArray(body.blocklistTitleKeywords)) {
        config.blocklistTitleKeywords = (body.blocklistTitleKeywords as string[]).filter(Boolean);
      }
      saveConfig(config);
      return json(res, { config });
    }
    if (req.method === 'POST' && path === '/api/data/delete') {
      const body = await readBody(req);
      const scope = body.scope === 'all' ? 'all' : 'today';
      return json(res, { removedDays: deleteCapturedData(scope) });
    }
    json(res, { error: 'not found' }, 404);
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

// ---------------------------------------------------------------------------
// Manual distill (the "Mine now" button)
//
// Runs as a child process so the model call never blocks this server (which
// may be the observer daemon itself). Not detached: we track its exit to
// report "running" honestly to the page.

let distillChildRunning = false;
let distillLastFinishedAt: string | null = null;

function startManualDistill(): { started: boolean; reason?: string } {
  if (distillChildRunning) return { started: false, reason: 'already running' };
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  distillChildRunning = true;
  const child = spawn(process.execPath, [cli, 'distill', '--source', 'screen'], { stdio: 'ignore' });
  child.on('close', () => {
    distillChildRunning = false;
    distillLastFinishedAt = new Date().toISOString();
  });
  child.on('error', () => {
    distillChildRunning = false;
    distillLastFinishedAt = new Date().toISOString();
  });
  return { started: true };
}

/** Start the dashboard. Resolves null when the port is already taken (daemon + standalone coexist). */
export function startDashboard(port?: number): Promise<Server | null> {
  const listenPort = port ?? loadConfig().dashboardPort;
  return new Promise((resolve) => {
    const server = createServer((req, res) => void handle(req, res));
    server.once('error', () => resolve(null));
    server.listen(listenPort, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// The page (palette matches thecontextlayer.ai)

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context Autopilot — Ambient</title>
<style>
  :root{--bg:#0a0e14;--bg2:#0f1522;--card:#131a2a;--border:#1f2a40;--text:#e6ebf4;--muted:#8b97ad;--accent:#00c8a0;--accent2:#5b8aff;--warn:#f5a623;--danger:#ff5d5d}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
  a{color:var(--accent2)}
  .wrap{max-width:980px;margin:0 auto;padding:28px 20px 80px}
  header{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#04281f;font-size:15px}
  h1{font-size:19px;font-weight:700}
  h1 span{color:var(--muted);font-weight:500}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
  .dot.on{background:var(--accent);box-shadow:0 0 8px var(--accent)}
  .dot.off{background:var(--danger)}
  .demo-banner{display:none;background:linear-gradient(90deg,rgba(245,166,35,.15),rgba(91,138,255,.12));border:1px solid rgba(245,166,35,.4);color:var(--warn);border-radius:10px;padding:9px 14px;font-size:13px;margin:14px 0}
  nav{display:flex;gap:6px;margin:18px 0;border-bottom:1px solid var(--border);padding-bottom:0}
  nav button{background:none;border:none;color:var(--muted);font:inherit;font-size:14px;font-weight:600;padding:9px 14px;cursor:pointer;border-bottom:2px solid transparent}
  nav button.active{color:var(--text);border-bottom-color:var(--accent)}
  nav button .badge{background:var(--accent);color:#04281f;border-radius:9px;font-size:11px;padding:1px 7px;margin-left:6px;font-weight:700}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
  .stat b{display:block;font-size:22px;font-weight:750}
  .stat span{color:var(--muted);font-size:12.5px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px}
  .rec{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)}
  .rec:last-child{border-bottom:none}
  .rec time{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;min-width:56px;padding-top:2px}
  .rec .app{font-weight:650;font-size:13.5px}
  .rec .title{color:var(--muted);font-size:13px;word-break:break-word}
  .chip{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;border-radius:6px;padding:1px 7px;margin-left:8px;vertical-align:1px}
  .chip.burst-end{background:rgba(0,200,160,.14);color:var(--accent)}
  .chip.dwell{background:rgba(91,138,255,.16);color:var(--accent2)}
  .chip.context-switch{background:rgba(245,166,35,.15);color:var(--warn)}
  .chip.demo{background:rgba(139,151,173,.18);color:var(--muted)}
  .thumb{width:104px;height:66px;object-fit:cover;object-position:top;border-radius:7px;border:1px solid var(--border);cursor:pointer;flex-shrink:0;margin-left:auto}
  .prop h3{font-size:15.5px;margin-bottom:2px}
  .prop .conf{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--warn)}
  .prop .conf.high{color:var(--accent)}
  .prop p{color:var(--muted);font-size:13.5px;margin:6px 0}
  .prop ol{margin:8px 0 8px 20px;font-size:13.5px}
  .prop blockquote{border-left:2px solid var(--border);padding-left:10px;color:var(--muted);font-size:12.5px;margin:4px 0}
  .btns{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
  button.act{border:none;border-radius:8px;font:inherit;font-size:13.5px;font-weight:650;padding:8px 16px;cursor:pointer}
  .approve{background:var(--accent);color:#04281f}
  .reject{background:var(--bg2);color:var(--muted);border:1px solid var(--border)!important}
  .run{background:var(--accent2);color:#fff}
  .ghost{background:var(--bg2);color:var(--text);border:1px solid var(--border)!important}
  .danger{background:rgba(255,93,93,.12);color:var(--danger);border:1px solid rgba(255,93,93,.35)!important}
  .summary-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px}
  .summary-head h3{font-size:15px}
  .usebars{display:flex;flex-direction:column;gap:7px;margin-top:4px}
  .usebar{display:grid;grid-template-columns:150px 1fr auto;align-items:center;gap:10px;font-size:13px}
  .usebar .bar{height:8px;border-radius:5px;background:var(--accent);min-width:2px}
  .usebar .bar.site{background:var(--accent2)}
  .usebar .amt{color:var(--muted);font-variant-numeric:tabular-nums}
  .summary .metrics{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:10px;color:var(--muted);font-size:13px}
  .summary .metrics b{color:var(--text);font-size:15px}
  .narrative{margin-top:14px;padding:13px 15px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;line-height:1.6}
  .minebar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px}
  .minebar .muted{font-size:13px;color:var(--muted)}
  #minebtn:disabled{opacity:.55;cursor:default}
  .offswitch{display:flex;align-items:center;justify-content:space-between;gap:14px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px}
  .offswitch b{font-size:16px}
  .offswitch .state{font-size:13px;color:var(--muted)}
  .bigoff{font-size:15px!important;padding:12px 26px!important}
  .bigoff.is-on{background:var(--danger);color:#fff}
  .bigoff.is-off{background:var(--accent);color:#04281f}
  textarea{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);font:13px/1.5 ui-monospace,monospace;padding:10px;min-height:70px}
  label.row{display:flex;gap:10px;align-items:center;font-size:14px;margin:10px 0}
  .empty{color:var(--muted);text-align:center;padding:30px 0;font-size:14px}
  .muted{color:var(--muted);font-size:12.5px}
  #lightbox{display:none;position:fixed;inset:0;background:rgba(4,7,12,.92);z-index:50;align-items:center;justify-content:center;cursor:zoom-out;padding:30px}
  #lightbox img{max-width:100%;max-height:100%;border-radius:10px;border:1px solid var(--border)}
  h2.sec{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:22px 0 10px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark">CA</div>
    <h1>Context Autopilot <span>· Ambient</span></h1>
    <div class="live"><span class="dot" id="livedot"></span><span id="livetext">…</span></div>
  </header>
  <div class="demo-banner" id="demobanner">Demo mode — you're looking at synthetic data replayed through the real pipeline. Your own data is untouched.</div>

  <nav>
    <button data-tab="today" class="active">Today</button>
    <button data-tab="patterns">Patterns<span class="badge" id="pendingbadge" style="display:none"></span></button>
    <button data-tab="autos">Automations</button>
    <button data-tab="controls">Controls</button>
  </nav>

  <section id="tab-today">
    <div class="stats">
      <div class="stat"><b id="s-moments">–</b><span>moments captured</span></div>
      <div class="stat"><b id="s-minutes">–</b><span>minutes observed</span></div>
      <div class="stat"><b id="s-apps">–</b><span>apps</span></div>
      <div class="stat"><b id="s-patterns">–</b><span>patterns awaiting review</span></div>
    </div>
    <div class="card summary" id="summary-card">
      <div class="summary-head">
        <h3>Your day so far</h3>
        <button class="act approve" id="narrate-btn" onclick="narrateDay()">✨ Summarize my day</button>
      </div>
      <div id="summary-body"><div class="empty">Nothing observed yet today.</div></div>
      <div id="narrative" class="narrative" style="display:none"></div>
    </div>
    <div class="card"><div id="timeline"><div class="empty">Nothing observed yet today.</div></div></div>
  </section>

  <section id="tab-patterns" style="display:none">
    <div class="minebar">
      <span class="muted" id="mine-hint">Autopilot mines on its own every couple of hours — or mine right now.</span>
      <button class="act approve" id="minebtn" onclick="mineNow()">⛏ Mine now</button>
    </div>
    <div id="proposals"></div>
  </section>
  <section id="tab-autos" style="display:none"><div id="aops"></div></section>

  <section id="tab-controls" style="display:none">
    <div class="offswitch">
      <div><b>Ambient observation</b><div class="state" id="offstate"></div></div>
      <button class="act bigoff" id="offbtn"></button>
    </div>
    <div class="card">
      <b>Pause instead?</b>
      <div class="btns">
        <button class="act ghost" onclick="control('pause',30)">Pause 30 min</button>
        <button class="act ghost" onclick="control('pause',120)">Pause 2 hours</button>
        <button class="act ghost" onclick="control('pause',720)">Pause until tomorrow</button>
      </div>
    </div>
    <div class="card">
      <b>Privacy</b>
      <label class="row"><input type="checkbox" id="textonly"> Text-only mode — delete every screenshot the moment its text is extracted</label>
      <div class="muted" id="shotstats"></div>
      <div class="btns">
        <button class="act danger" onclick="wipe('today')">Delete today's captures</button>
        <button class="act danger" onclick="wipe('all')">Delete ALL captured data</button>
      </div>
    </div>
    <div class="card">
      <b>Never capture these apps</b> <span class="muted">(one per line)</span>
      <textarea id="blockapps"></textarea>
      <b style="display:block;margin-top:12px">Never capture window titles containing</b> <span class="muted">(one per line)</span>
      <textarea id="blocktitles"></textarea>
      <div class="btns"><button class="act approve" onclick="saveBlocklists()">Save blocklists</button></div>
    </div>
  </section>
</div>
<div id="lightbox" onclick="this.style.display='none'"><img id="lightimg"></div>

<script>
var status = null;
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function api(path, body){
  var opts = body ? {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)} : {};
  return fetch(path, opts).then(function(r){ return r.json(); });
}

document.querySelectorAll('nav button').forEach(function(btn){
  btn.onclick = function(){
    document.querySelectorAll('nav button').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    ['today','patterns','autos','controls'].forEach(function(t){
      document.getElementById('tab-'+t).style.display = (btn.dataset.tab===t) ? '' : 'none';
    });
    if (btn.dataset.tab==='today') refreshSummary();
    if (btn.dataset.tab==='patterns') loadProposals();
    if (btn.dataset.tab==='autos') loadAops();
  };
});

function refreshStatus(){
  api('/api/status').then(function(s){
    status = s;
    document.getElementById('demobanner').style.display = s.demo ? 'block' : 'none';
    var dot = document.getElementById('livedot'), txt = document.getElementById('livetext');
    if (!s.enabled) { dot.className='dot off'; txt.textContent='OFF'; }
    else if (s.pausedUntil && s.pausedUntil > new Date().toISOString()) { dot.className='dot'; txt.textContent='paused'; }
    else if (s.observing) { dot.className='dot on'; txt.textContent='observing'; }
    else { dot.className='dot'; txt.textContent='observer not running'; }
    document.getElementById('s-moments').textContent = s.momentsToday;
    document.getElementById('s-minutes').textContent = s.observedMinutes;
    document.getElementById('s-apps').textContent = s.appsToday.length;
    document.getElementById('s-patterns').textContent = s.pendingProposals;
    var badge = document.getElementById('pendingbadge');
    badge.style.display = s.pendingProposals > 0 ? '' : 'none';
    badge.textContent = s.pendingProposals;
    var offbtn = document.getElementById('offbtn');
    offbtn.className = 'act bigoff ' + (s.enabled ? 'is-on' : 'is-off');
    offbtn.textContent = s.enabled ? 'Turn OFF' : 'Turn ON';
    offbtn.onclick = function(){ control(s.enabled ? 'off' : 'on'); };
    document.getElementById('offstate').textContent = s.enabled
      ? 'ON — capturing at intentional moments. Everything stays on this Mac.'
      : 'OFF — nothing is captured until you turn it back on. This survives restarts.';
    document.getElementById('textonly').checked = s.textOnly;
    document.getElementById('shotstats').textContent = s.screenshots.count + ' screenshot(s) on disk (' + (s.screenshots.bytes/1048576).toFixed(1) + ' MB), auto-deleted after ' + s.retentionDays + ' days';
    if (!blocklistDirty) {
      document.getElementById('blockapps').value = s.blocklistApps.join('\\n');
      document.getElementById('blocktitles').value = s.blocklistTitleKeywords.join('\\n');
    }
  }).catch(function(){});
}

function refreshTimeline(){
  api('/api/day').then(function(data){
    var el = document.getElementById('timeline');
    if (!data.records.length) { el.innerHTML = '<div class="empty">Nothing observed yet today.</div>'; return; }
    el.innerHTML = data.records.map(function(r){
      var thumb = r.screenshot ? '<img class="thumb" src="/shot/'+esc(r.screenshot)+'" onclick="lightbox(this.src)">' : '';
      var from = r.fromApp ? '<span class="muted"> ← from '+esc(r.fromApp)+'</span>' : '';
      return '<div class="rec"><time>'+esc(r.timestamp.slice(11,16))+'</time><div style="flex:1;min-width:0">'
        + '<div class="app">'+esc(r.app)+'<span class="chip '+esc(r.trigger)+'">'+esc(r.trigger)+'</span>'+from+'</div>'
        + '<div class="title">'+esc(r.windowTitle)+'</div></div>'+thumb+'</div>';
    }).join('');
  }).catch(function(){});
}

function fmtDur(sec){ var m=Math.round(sec/60); if(m<60) return m+'m'; return Math.floor(m/60)+'h '+(m%60)+'m'; }

function refreshSummary(){
  api('/api/summary').then(function(s){
    var body = document.getElementById('summary-body');
    var btn = document.getElementById('narrate-btn');
    if (!s.segmentCount){ body.innerHTML = '<div class="empty">Nothing observed yet today.</div>'; btn.disabled = true; return; }
    btn.disabled = false;
    var maxApp = Math.max.apply(null, s.apps.map(function(a){return a.activeSeconds;}).concat([1]));
    var maxSite = Math.max.apply(null, s.sites.map(function(x){return x.seconds;}).concat([1]));
    var metrics = '<div class="metrics">'
      + '<span><b>'+fmtDur(s.activeSeconds)+'</b> active</span>'
      + '<span><b>'+fmtDur(s.totalSeconds)+'</b> observed</span>'
      + '<span><b>'+s.keys.toLocaleString()+'</b> keystrokes</span>'
      + '<span><b>'+s.clicks.toLocaleString()+'</b> clicks</span>'
      + (s.busiestHour ? '<span>busiest <b>'+((s.busiestHour.hour%12||12))+(s.busiestHour.hour<12?'am':'pm')+'</b></span>' : '')
      + '</div>';
    var apps = s.apps.map(function(a){
      return '<div class="usebar"><span>'+esc(a.app)+'</span><span class="bar" style="width:'+Math.round(a.activeSeconds/maxApp*100)+'%"></span><span class="amt">'+fmtDur(a.activeSeconds)+'</span></div>';
    }).join('');
    var sites = s.sites.length ? '<div class="muted" style="margin:12px 0 4px">Top sites</div>' + s.sites.map(function(x){
      return '<div class="usebar"><span>'+esc(x.host)+'</span><span class="bar site" style="width:'+Math.round(x.seconds/maxSite*100)+'%"></span><span class="amt">'+fmtDur(x.seconds)+'</span></div>';
    }).join('') : '';
    body.innerHTML = metrics + '<div class="usebars">'+apps+'</div>' + (sites?'<div class="usebars">'+sites+'</div>':'');
  }).catch(function(){});
}

function narrateDay(){
  var btn = document.getElementById('narrate-btn');
  var box = document.getElementById('narrative');
  btn.disabled = true; btn.textContent = 'Thinking…';
  box.style.display = 'block'; box.textContent = 'Reading your day…';
  api('/api/summary/narrate', {}).then(function(r){
    box.textContent = r.narrative || r.error || 'Could not summarize right now.';
    btn.disabled = false; btn.textContent = '✨ Summarize my day';
  }).catch(function(){ box.textContent = 'Could not summarize right now.'; btn.disabled = false; btn.textContent = '✨ Summarize my day'; });
}

function lightbox(src){
  document.getElementById('lightimg').src = src;
  document.getElementById('lightbox').style.display = 'flex';
}

function mineNow(){
  var btn = document.getElementById('minebtn');
  var hint = document.getElementById('mine-hint');
  btn.disabled = true; btn.textContent = 'Mining…';
  hint.textContent = 'Reading today\\'s moments and looking for repeated workflows (up to a minute or two)…';
  api('/api/distill', {}).then(function(r){
    if (!r.started) { hint.textContent = 'A mining run is already in progress — results will appear here.'; }
    var poll = setInterval(function(){
      api('/api/distill/status').then(function(s){
        if (s.running) return;
        clearInterval(poll);
        btn.disabled = false; btn.textContent = '⛏ Mine now';
        loadProposals();
        hint.textContent = 'Done. New patterns (if any) are below — a workflow surfaces once it repeats, even twice in one day.';
      });
    }, 3000);
  });
}

function loadProposals(){
  api('/api/proposals').then(function(props){
    var pending = props.filter(function(p){ return p.status==='pending'; });
    var done = props.filter(function(p){ return p.status!=='pending'; });
    var el = document.getElementById('proposals');
    if (!props.length) { el.innerHTML = '<div class="card"><div class="empty">No patterns detected yet. Keep working — Autopilot mines for patterns every couple of hours (it waits for a moment you step away), plus a nightly sweep. A workflow surfaces once it repeats, even twice in the same day. Impatient? Run: ctxlayer distill --source screen.</div></div>'; return; }
    el.innerHTML = pending.map(function(p){
      var e = p.entry;
      var steps = (e.procedure||[]).map(function(s){ return '<li>'+esc(s)+'</li>'; }).join('');
      var quotes = (e.evidence||[]).slice(0,4).map(function(ev){ return '<blockquote>'+esc(ev.quote)+'</blockquote>'; }).join('');
      var trig = e.trigger ? '<p class="muted">Live trigger: when you open <b>'+esc(e.trigger.app)+'</b>'+(e.trigger.titlePattern?' ("'+esc(e.trigger.titlePattern)+'")':'')+'</p>' : '';
      return '<div class="card prop"><h3>'+esc(e.title)+' <span class="conf '+esc(e.confidence)+'">'+esc(e.confidence)+' confidence</span></h3>'
        + '<p>'+esc(e.rule)+'</p><ol>'+steps+'</ol>'+quotes+trig
        + '<div class="btns"><button class="act approve" onclick="decide(\\''+esc(e.title).replace(/'/g,"\\\\'")+'\\',true)">Approve — automate this</button>'
        + '<button class="act reject" onclick="decide(\\''+esc(e.title).replace(/'/g,"\\\\'")+'\\',false)">Not this one</button></div></div>';
    }).join('') + (done.length ? '<h2 class="sec">Already decided</h2>' + done.map(function(p){
      return '<div class="card"><b>'+esc(p.entry.title)+'</b> <span class="muted">— '+esc(p.status)+'</span></div>';
    }).join('') : '');
    if (!pending.length && done.length) el.insertAdjacentHTML('afterbegin','<div class="card"><div class="empty">All caught up — every proposal has been reviewed.</div></div>');
  });
}

function decide(title, accept){
  api('/api/proposals/decide', accept ? {accept:[title],reject:[]} : {accept:[],reject:[title]}).then(function(){
    loadProposals(); refreshStatus();
  });
}

function loadAops(){
  api('/api/aops').then(function(aops){
    var el = document.getElementById('aops');
    if (!aops.length) { el.innerHTML = '<div class="card"><div class="empty">No automations yet. Approve a pattern and it lands here.</div></div>'; return; }
    el.innerHTML = aops.map(function(a){
      var steps = (a.procedure||[]).map(function(s){ return '<li>'+esc(s)+'</li>'; }).join('');
      var trig = a.trigger ? '<p class="muted">Offers to run when you open <b>'+esc(a.trigger.app)+'</b>'+(a.trigger.titlePattern?' ("'+esc(a.trigger.titlePattern)+'")':'')+'</p>' : '';
      return '<div class="card prop"><h3>'+esc(a.title)+' '+(a.enabled?'':'<span class="muted">(off)</span>')+'</h3>'
        + '<p>'+esc(a.rule)+'</p><ol>'+steps+'</ol>'+trig
        + '<div class="btns"><button class="act run" onclick="runAop(\\''+esc(a.slug)+'\\')">Run now</button>'
        + '<button class="act ghost" onclick="toggleAop(\\''+esc(a.slug)+'\\','+(!a.enabled)+')">'+(a.enabled?'Disable':'Enable')+'</button></div></div>';
    }).join('');
  });
}

function runAop(slug){ api('/api/aops/run',{slug:slug}).then(function(){ alert('Opening a Claude Code session in Terminal with this procedure…'); }); }
function toggleAop(slug, enabled){ api('/api/aops/toggle',{slug:slug,enabled:enabled}).then(loadAops); }
function control(action, minutes){ api('/api/control',{action:action,minutes:minutes}).then(refreshStatus); }
function wipe(scope){
  if (!confirm(scope==='all' ? 'Delete ALL captured screenshots and activity records? This cannot be undone.' : "Delete today's captures?")) return;
  api('/api/data/delete',{scope:scope}).then(function(){ refreshStatus(); refreshTimeline(); });
}

var blocklistDirty = false;
['blockapps','blocktitles'].forEach(function(id){
  document.getElementById(id).addEventListener('input', function(){ blocklistDirty = true; });
});
function saveBlocklists(){
  api('/api/config', {
    blocklistApps: document.getElementById('blockapps').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
    blocklistTitleKeywords: document.getElementById('blocktitles').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean)
  }).then(function(){ blocklistDirty = false; refreshStatus(); });
}
document.getElementById('textonly').addEventListener('change', function(e){
  api('/api/config', {textOnly: e.target.checked}).then(refreshStatus);
});

refreshStatus(); refreshTimeline(); refreshSummary();
setInterval(refreshStatus, 4000);
setInterval(refreshTimeline, 4000);
setInterval(refreshSummary, 8000);
</script>
</body>
</html>`;
