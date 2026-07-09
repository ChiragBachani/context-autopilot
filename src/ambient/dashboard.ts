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
import { readRuns, syncAopSchedule } from './runner.js';
import { searchHistory } from './search.js';
import { generateAndSaveRecap, loadRecap, summarizeDayFromDisk } from './summarize.js';
import {
  applyWorkflowDecisions,
  buildDayMoments,
  buildEpisodes,
  createAop,
  deleteAop,
  loadAops,
  loadWorkflowProposals,
  setAopEnabled,
  updateAop,
  type AopPatch,
} from './workflows.js';

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
    if (req.method === 'GET' && path === '/api/recap') {
      return json(res, loadRecap(dayKey()) ?? { narrative: null });
    }
    if (req.method === 'POST' && path === '/api/summary/narrate') {
      try {
        const recap = await generateAndSaveRecap(dayKey());
        return json(res, recap ?? { narrative: null });
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    if (req.method === 'GET' && path === '/api/days') return json(res, listDays());
    if (req.method === 'GET' && path === '/api/episodes') {
      const days = listDays();
      const day = url.searchParams.get('day') ?? days[0] ?? dayKey();
      const episodes = buildEpisodes(day, buildDayMoments(day)).map((e) => ({
        start: e.start,
        end: e.end,
        seconds: Math.round((Date.parse(e.end) - Date.parse(e.start)) / 1000),
        steps: e.steps.map((s) => ({ at: s.timestamp, app: s.app, title: s.title, url: s.url, textDigest: s.textDigest })),
      }));
      // Newest episode first — what just happened is what you'd automate.
      episodes.reverse();
      return json(res, { day, days, episodes });
    }
    if (req.method === 'POST' && path === '/api/episodes/automate') {
      const body = await readBody(req);
      return automateEpisode(res, String(body.day ?? dayKey()), String(body.start ?? ''));
    }
    if (req.method === 'GET' && path === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      return json(res, { query: q, hits: searchHistory(q) });
    }
    if (req.method === 'POST' && path === '/api/aops/update') {
      const body = await readBody(req);
      const patch: AopPatch = {
        title: typeof body.title === 'string' ? body.title : undefined,
        rule: typeof body.rule === 'string' ? body.rule : undefined,
        procedure: Array.isArray(body.procedure) ? (body.procedure as string[]) : undefined,
        trigger:
          body.trigger === null
            ? null
            : body.trigger && typeof body.trigger === 'object'
              ? (body.trigger as AopPatch['trigger'])
              : undefined,
        schedule:
          body.schedule === null
            ? null
            : body.schedule && typeof body.schedule === 'object'
              ? (body.schedule as AopPatch['schedule'])
              : undefined,
      };
      const aop = updateAop(String(body.slug ?? ''), patch);
      if (aop) syncAopSchedule(aop);
      return json(res, aop ?? { error: 'not found' }, aop ? 200 : 404);
    }
    if (req.method === 'POST' && path === '/api/aops/delete') {
      const body = await readBody(req);
      const slug = String(body.slug ?? '');
      syncAopSchedule({ slug, enabled: false, schedule: undefined }); // unload any agent first
      const ok = deleteAop(slug);
      return json(res, ok ? { deleted: true } : { error: 'not found' }, ok ? 200 : 404);
    }
    if (req.method === 'POST' && path === '/api/aops/create') {
      const body = await readBody(req);
      const title = String(body.title ?? '').trim();
      const procedure = Array.isArray(body.procedure) ? (body.procedure as string[]) : [];
      if (!title || procedure.length === 0) {
        return json(res, { error: 'a title and at least one step are required' }, 400);
      }
      const aop = createAop({
        title,
        rule: typeof body.rule === 'string' ? body.rule : undefined,
        procedure,
        trigger: body.trigger && typeof body.trigger === 'object' ? (body.trigger as AopPatch['trigger'] as never) : undefined,
        schedule: body.schedule && typeof body.schedule === 'object' ? (body.schedule as never) : undefined,
      });
      syncAopSchedule(aop);
      return json(res, aop);
    }
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
    if (req.method === 'GET' && path === '/api/aops/runs') {
      return json(res, readRuns(url.searchParams.get('slug') ?? undefined).slice(0, 50));
    }
    if (req.method === 'POST' && path === '/api/aops/toggle') {
      const body = await readBody(req);
      const aop = setAopEnabled(String(body.slug ?? ''), Boolean(body.enabled));
      if (aop) syncAopSchedule(aop); // disabling also unloads its schedule
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

/**
 * "⚡ Automate this": distill one episode via a child CLI process (the model
 * call must never block this server — it may be the observer daemon). The
 * HTTP response waits for the child, which is fine on localhost.
 */
function automateEpisode(res: ServerResponse, day: string, start: string): void {
  if (!start) return json(res, { error: 'missing episode start' }, 400);
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'automate-episode', '--day', day, '--start', start], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += String(d)));
  child.stderr.on('data', (d) => (err += String(d)));
  child.on('close', (code) => {
    if (code === 0) {
      try {
        return json(res, JSON.parse(out) as Record<string, unknown>);
      } catch {
        return json(res, { error: 'unexpected distiller output' }, 500);
      }
    }
    json(res, { error: err.trim() || `automation failed (exit ${code})` }, 500);
  });
  child.on('error', (e) => json(res, { error: e.message }, 500));
}

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
  .chip.new-page{background:rgba(186,120,255,.16);color:#ba78ff}
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
  .aopform label{display:block;margin:10px 0 0;font-size:12.5px;color:var(--muted)}
  .aopform input,.aopform textarea{display:block;width:100%;margin-top:4px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit;font-size:13.5px;padding:8px 11px}
  .aopform input:focus,.aopform textarea:focus{outline:none;border-color:var(--accent2)}
  .aopform .triggerrow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
  .schedrow{display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}
  .schedrow input[type=time]{background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit;padding:6px 9px}
  .daychk{display:inline-flex;align-items:center;gap:3px;font-size:12px;color:var(--muted);margin-right:7px;cursor:pointer}
  .daychk input{width:auto!important;display:inline!important;margin:0}
  .lastrun{font-size:12.5px;margin-top:6px}
  .searchbar{display:flex;gap:8px;margin-bottom:14px}
  .searchbar input{flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:9px;color:var(--text);font:inherit;font-size:14px;padding:9px 13px}
  .searchbar input:focus{outline:none;border-color:var(--accent2)}
  .hit{display:flex;gap:12px;align-items:baseline;padding:9px 4px;border-bottom:1px solid var(--border);font-size:13.5px}
  .hit time{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
  .hit .snip{color:var(--muted);display:block;margin-top:2px}
  .daynav{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .daynav b{min-width:110px;text-align:center}
  .ep{margin-bottom:14px}
  .ep h3{font-size:14px;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .ep .flow{margin:8px 0 2px}
  .ep .step{display:grid;grid-template-columns:44px 1fr;gap:10px;padding:4px 0;font-size:13.5px;align-items:baseline}
  .ep .step time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12.5px}
  .ep .step .t{color:var(--muted)}
  .ep .step b{font-weight:600}
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
    <button data-tab="activity">Activity</button>
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

  <section id="tab-activity" style="display:none">
    <div class="searchbar">
      <input id="searchbox" type="search" placeholder="Search everything you've seen — OCR text, titles, URLs…" onkeydown="if(event.key==='Enter')runSearch()">
      <button class="act ghost" onclick="runSearch()">Search</button>
      <button class="act ghost" id="clearsearch" style="display:none" onclick="clearSearch()">Clear</button>
    </div>
    <div id="searchresults" style="display:none"></div>
    <div id="activity-main">
      <div class="daynav">
        <button class="act ghost" onclick="stepDay(1)">‹</button>
        <b id="daylabel">today</b>
        <button class="act ghost" onclick="stepDay(-1)">›</button>
        <span class="muted" id="epcount"></span>
      </div>
      <div id="episodes"></div>
    </div>
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
    location.hash = btn.dataset.tab; // deep-linkable tabs (e.g. /#activity)
    document.querySelectorAll('nav button').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    ['today','activity','patterns','autos','controls'].forEach(function(t){
      document.getElementById('tab-'+t).style.display = (btn.dataset.tab===t) ? '' : 'none';
    });
    if (btn.dataset.tab==='today') refreshSummary();
    if (btn.dataset.tab==='activity') loadEpisodes();
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

function showRecap(r){
  var box = document.getElementById('narrative');
  if (!r || !r.narrative) return;
  var when = r.generatedAt ? new Date(r.generatedAt) : null;
  var stamp = when ? ' <span class="muted" style="font-size:12px">(as of '+when.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})+')</span>' : '';
  box.style.display = 'block';
  box.innerHTML = esc(r.narrative) + stamp;
}

function loadRecap(){ api('/api/recap').then(showRecap).catch(function(){}); }

function narrateDay(){
  var btn = document.getElementById('narrate-btn');
  var box = document.getElementById('narrative');
  btn.disabled = true; btn.textContent = 'Thinking…';
  box.style.display = 'block'; box.textContent = 'Reading your day…';
  api('/api/summary/narrate', {}).then(function(r){
    if (r.narrative) showRecap(r); else box.textContent = r.error || 'Could not summarize right now.';
    btn.disabled = false; btn.textContent = '✨ Summarize my day';
  }).catch(function(){ box.textContent = 'Could not summarize right now.'; btn.disabled = false; btn.textContent = '✨ Summarize my day'; });
}

function lightbox(src){
  document.getElementById('lightimg').src = src;
  document.getElementById('lightbox').style.display = 'flex';
}

// --- Activity tab: episodes + automate + search ---
var epDays = [], epDay = null;

function loadEpisodes(day){
  var q = day ? '?day='+encodeURIComponent(day) : '';
  api('/api/episodes'+q).then(function(r){
    epDays = r.days; epDay = r.day;
    var today = epDays[0];
    document.getElementById('daylabel').textContent = (epDay===today) ? 'today' : epDay;
    document.getElementById('epcount').textContent = r.episodes.length + ' episode(s)';
    var el = document.getElementById('episodes');
    if (!r.episodes.length){ el.innerHTML = '<div class="card"><div class="empty">No activity recorded for this day.</div></div>'; return; }
    el.innerHTML = r.episodes.map(function(e){
      var dur = Math.round(e.seconds/60);
      var apps = []; e.steps.forEach(function(s){ if(apps[apps.length-1]!==s.app) apps.push(s.app); });
      var steps = e.steps.map(function(s){
        var where = s.url ? ' <span class="muted">·</span> <span class="t">'+esc(s.url.replace(/^https?:\\/\\//,'').slice(0,60))+'</span>' : '';
        var digest = s.textDigest ? '<span class="snip">“'+esc(s.textDigest.slice(0,110))+'”</span>' : '';
        return '<div class="step"><time>'+esc((s.at||'').slice(11,16))+'</time><span><b>'+esc(s.app)+'</b> <span class="t">'+esc(s.title.slice(0,70))+'</span>'+where+digest+'</span></div>';
      }).join('');
      return '<div class="card ep"><h3><span>'+esc(e.start.slice(11,16))+'–'+esc(e.end.slice(11,16))+' <span class="muted">('+dur+'m · '+esc(apps.join(' → '))+')</span></span>'
        + '<button class="act approve" onclick="automateEp(this, \\''+esc(e.start)+'\\')">⚡ Automate this</button></h3>'
        + '<div class="flow">'+steps+'</div></div>';
    }).join('');
  }).catch(function(){});
}

function stepDay(dir){
  if (!epDays.length) return;
  var i = epDays.indexOf(epDay) + dir; // days are newest-first: +1 = older
  if (i < 0 || i >= epDays.length) return;
  loadEpisodes(epDays[i]);
}

function automateEp(btn, start){
  btn.disabled = true; btn.textContent = 'Creating…';
  api('/api/episodes/automate', {day: epDay, start: start}).then(function(r){
    if (r.error){ btn.textContent = '⚡ Automate this'; btn.disabled = false; alert(r.error); return; }
    btn.textContent = 'Added ✓ (see Automations)';
  }).catch(function(){ btn.textContent = '⚡ Automate this'; btn.disabled = false; alert('Could not create the automation.'); });
}

function runSearch(){
  var q = document.getElementById('searchbox').value.trim();
  if (q.length < 2) return;
  api('/api/search?q='+encodeURIComponent(q)).then(function(r){
    var el = document.getElementById('searchresults');
    document.getElementById('activity-main').style.display = 'none';
    document.getElementById('clearsearch').style.display = '';
    el.style.display = '';
    if (!r.hits.length){ el.innerHTML = '<div class="card"><div class="empty">No matches for “'+esc(q)+'”.</div></div>'; return; }
    el.innerHTML = '<div class="card">' + r.hits.map(function(h){
      var thumb = h.screenshot ? ' <a href="/shot/'+esc(h.screenshot)+'" onclick="lightbox(this.href);return false" class="muted">📸</a>' : '';
      var where = h.url ? ' <span class="muted">'+esc(h.url.replace(/^https?:\\/\\//,'').slice(0,50))+'</span>' : '';
      var snip = h.snippet ? '<span class="snip">“'+esc(h.snippet)+'”</span>' : '';
      return '<div class="hit"><time>'+esc(h.day)+' '+esc(h.timestamp.slice(11,16))+'</time><span><b>'+esc(h.app)+'</b> '+esc(h.windowTitle.slice(0,60))+where+thumb+snip+'</span></div>';
    }).join('') + '</div>';
  }).catch(function(){});
}

function clearSearch(){
  document.getElementById('searchbox').value = '';
  document.getElementById('searchresults').style.display = 'none';
  document.getElementById('activity-main').style.display = '';
  document.getElementById('clearsearch').style.display = 'none';
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

var aopCache = [];

function aopForm(a){
  // Shared edit/create form. a = existing aop or null for a new one.
  var t = (a && a.trigger) || {};
  return '<div class="aopform">'
    + '<label>Title<input id="af-title" value="'+esc(a?a.title:'')+'" placeholder="Weekly metrics report"></label>'
    + '<label>When / what (one sentence)<input id="af-rule" value="'+esc(a?a.rule:'')+'" placeholder="Every Monday, compile the metrics and email the summary."></label>'
    + '<label>Steps (one per line)<textarea id="af-steps" rows="6" placeholder="Open mail.google.com and find the metrics export…">'+esc(a?(a.procedure||[]).join('\\n'):'')+'</textarea></label>'
    + '<div class="triggerrow"><label>Trigger app<input id="af-tapp" value="'+esc(t.app||'')+'" placeholder="Google Chrome"></label>'
    + '<label>Title contains<input id="af-ttitle" value="'+esc(t.titlePattern||'')+'" placeholder="Inbox"></label>'
    + '<label>URL contains<input id="af-turl" value="'+esc(t.urlPattern||'')+'" placeholder="mail.google.com"></label></div>'
    + '<p class="muted" style="font-size:12.5px">Trigger is optional — when set, Autopilot offers to run this the moment you start the workflow.</p>'
    + '<div class="schedrow"><label style="flex:0 0 auto;display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="af-sched" '+(a&&a.schedule?'checked':'')+' style="width:auto;display:inline"> Run on a schedule</label>'
    + '<input id="af-stime" type="time" value="'+(a&&a.schedule?pad2(a.schedule.hour)+':'+pad2(a.schedule.minute):'09:00')+'" style="width:110px">'
    + '<span class="days">'+[0,1,2,3,4,5,6].map(function(d){var on=a&&a.schedule&&a.schedule.weekdays&&a.schedule.weekdays.indexOf(d)>=0;return '<label class="daychk"><input type="checkbox" data-day="'+d+'" '+(on?'checked':'')+'>'+['Su','Mo','Tu','We','Th','Fr','Sa'][d]+'</label>';}).join('')+'</span></div>'
    + '<p class="muted" style="font-size:12.5px">No days checked = every day. Scheduled runs open a visible session and leave a receipt.</p>'
    + '<div class="btns"><button class="act approve" onclick="saveAopForm(\\''+esc(a?a.slug:'')+'\\')">Save</button>'
    + '<button class="act ghost" onclick="loadAops()">Cancel</button></div></div>';
}

function pad2(n){ return (n<10?'0':'')+n; }

function readSchedule(){
  if (!document.getElementById('af-sched').checked) return null;
  var t = document.getElementById('af-stime').value.split(':');
  var days = [];
  document.querySelectorAll('.daychk input:checked').forEach(function(c){ days.push(Number(c.dataset.day)); });
  return { weekdays: days, hour: Number(t[0]||9), minute: Number(t[1]||0) };
}

function readAopForm(){
  var t = {
    app: document.getElementById('af-tapp').value.trim(),
    titlePattern: document.getElementById('af-ttitle').value.trim() || undefined,
    urlPattern: document.getElementById('af-turl').value.trim() || undefined
  };
  return {
    title: document.getElementById('af-title').value.trim(),
    rule: document.getElementById('af-rule').value.trim(),
    procedure: document.getElementById('af-steps').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
    trigger: t.app ? t : null
  };
}

function saveAopForm(slug){
  var f = readAopForm();
  if (!f.title || !f.procedure.length){ alert('A title and at least one step are required.'); return; }
  var sched = readSchedule();
  var call = slug
    ? api('/api/aops/update', {slug: slug, title: f.title, rule: f.rule, procedure: f.procedure, trigger: f.trigger, schedule: sched})
    : api('/api/aops/create', {title: f.title, rule: f.rule, procedure: f.procedure, trigger: f.trigger || undefined, schedule: sched || undefined});
  call.then(function(r){ if (r.error) alert(r.error); loadAops(); });
}

function editAop(slug){
  var a = aopCache.find(function(x){ return x.slug === slug; });
  if (!a) return;
  document.getElementById('aop-'+slug).innerHTML = '<h3>Edit: '+esc(a.title)+'</h3>' + aopForm(a);
}

function newAop(){
  document.getElementById('newaop').innerHTML = '<div class="card prop"><h3>New automation</h3>'+aopForm(null)+'</div>';
}

function loadAops(){
  api('/api/aops').then(function(aops){
    aopCache = aops;
    var el = document.getElementById('aops');
    var header = '<div class="minebar"><span class="muted">Automations run via a Claude session preloaded with the procedure — mined from patterns, promoted from Activity, or written by hand.</span>'
      + '<button class="act approve" onclick="newAop()">＋ New automation</button></div><div id="newaop"></div>';
    if (!aops.length) { el.innerHTML = header + '<div class="card"><div class="empty">No automations yet. Approve a pattern, hit ⚡ on an Activity episode, or write one by hand.</div></div>'; return; }
    el.innerHTML = header + aops.map(function(a){
      var steps = (a.procedure||[]).map(function(s){ return '<li>'+esc(s)+'</li>'; }).join('');
      var trig = a.trigger ? '<p class="muted">Offers to run when you open <b>'+esc(a.trigger.app)+'</b>'+(a.trigger.titlePattern?' ("'+esc(a.trigger.titlePattern)+'")':'')+(a.trigger.urlPattern?' <span class="t">['+esc(a.trigger.urlPattern)+']</span>':'')+'</p>' : '';
      var sched = a.schedule ? '<p class="muted">⏰ Runs '+scheduleLabelText(a.schedule)+'</p>' : '';
      var manual = a.source === 'manual' ? ' <span class="muted" style="font-size:11px">(hand-made)</span>' : '';
      return '<div class="card prop" id="aop-'+esc(a.slug)+'"><h3>'+esc(a.title)+manual+' '+(a.enabled?'':'<span class="muted">(off)</span>')+'</h3>'
        + '<p>'+esc(a.rule)+'</p><ol>'+steps+'</ol>'+trig+sched
        + '<div class="lastrun muted" id="lastrun-'+esc(a.slug)+'"></div>'
        + '<div class="btns"><button class="act run" onclick="runAop(\\''+esc(a.slug)+'\\')">Run now</button>'
        + '<button class="act ghost" onclick="showRuns(\\''+esc(a.slug)+'\\')">Receipts</button>'
        + '<button class="act ghost" onclick="editAop(\\''+esc(a.slug)+'\\')">Edit</button>'
        + '<button class="act ghost" onclick="toggleAop(\\''+esc(a.slug)+'\\','+(!a.enabled)+')">'+(a.enabled?'Disable':'Enable')+'</button>'
        + '<button class="act danger" onclick="deleteAopUi(\\''+esc(a.slug)+'\\')">Delete</button></div>'
        + '<div id="runs-'+esc(a.slug)+'"></div></div>';
    }).join('');
    aops.forEach(function(a){ loadLastRun(a.slug); });
  });
}

function scheduleLabelText(s){
  var days = (s.weekdays&&s.weekdays.length) ? s.weekdays.map(function(d){return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d];}).join(', ') : 'every day';
  return days + ' at ' + pad2(s.hour)+':'+pad2(s.minute);
}

function runBadge(r){
  if (!r.finishedAt) return '<span class="muted">… running</span>';
  return r.exitCode === 0 ? '<span style="color:var(--accent)">✓</span>' : '<span style="color:var(--danger)">✗</span>';
}

function loadLastRun(slug){
  api('/api/aops/runs?slug='+encodeURIComponent(slug)).then(function(runs){
    var el = document.getElementById('lastrun-'+slug);
    if (!el || !runs.length) return;
    var r = runs[0];
    el.innerHTML = 'Last run '+runBadge(r)+' '+new Date(r.startedAt).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})
      + (r.seconds!=null?' · '+Math.round(r.seconds/60)+'m':'') + (r.origin==='scheduled'?' · scheduled':'');
  }).catch(function(){});
}

function showRuns(slug){
  var el = document.getElementById('runs-'+slug);
  if (el.innerHTML){ el.innerHTML=''; return; }
  api('/api/aops/runs?slug='+encodeURIComponent(slug)).then(function(runs){
    if (!runs.length){ el.innerHTML = '<p class="muted" style="margin-top:8px">No runs yet.</p>'; return; }
    el.innerHTML = runs.slice(0,10).map(function(r){
      var when = new Date(r.startedAt).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
      var dur = r.seconds!=null ? Math.max(1,Math.round(r.seconds/60))+'m' : '';
      var sum = r.summary ? '<div class="snip">'+esc(r.summary)+'</div>' : '<div class="snip muted">(no receipt written)</div>';
      return '<div class="hit"><time>'+when+'</time><span>'+runBadge(r)+' '+esc(r.mode)+(r.origin!=='manual'?' · '+esc(r.origin):'')+' '+dur+sum+'</span></div>';
    }).join('');
  }).catch(function(){});
}

function runAop(slug){ api('/api/aops/run',{slug:slug}).then(function(){ alert('Opening a Claude Code session in Terminal with this procedure…'); }); }
function deleteAopUi(slug){ if(!confirm('Delete this automation? This cannot be undone.')) return; api('/api/aops/delete',{slug:slug}).then(loadAops); }
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

// Honor a deep link like /#activity on load.
(function(){
  var t = location.hash.replace('#','');
  var btn = document.querySelector('nav button[data-tab="'+t+'"]');
  if (btn) btn.click();
})();
refreshStatus(); refreshTimeline(); refreshSummary(); loadRecap();
setInterval(refreshStatus, 4000);
setInterval(refreshTimeline, 4000);
setInterval(refreshSummary, 8000);
</script>
</body>
</html>`;
