// Tinker hub (Swiss Pro): one static page; the URL path picks which tool renders. All data is inserted
// as text (never as HTML), because notes and AI output come from outside. Styles are set through the
// CSSOM (el.style), which the strict Content-Security-Policy allows.
const view = document.getElementById('view');
const logoutBtn = document.querySelector('.logout');
const tabs = document.querySelector('.tabs');
const statusEl = document.getElementById('status');
const devicesLink = document.querySelector('.devices');
// The phone's tab row sticks just below the header, whatever the header's height.
const setTopHeight = () => document.documentElement.style.setProperty('--toph', `${document.querySelector('.top')?.offsetHeight || 64}px`);
setTopHeight(); addEventListener('resize', setTopHeight);

// ---------- tiny helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const ist = () => new Date(Date.now() + 5.5 * 3600e3);
const today = () => ist().toISOString().slice(0, 10);
const monthName = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');
// Whose job agent the /jobs pages show: ?who= (empty = the owner). Names come from the server, never from this file.
const who = () => new URLSearchParams(location.search).get('who') || '';
const withWho = (path) => (who() ? `${path}${path.includes('?') ? '&' : '?'}who=${encodeURIComponent(who())}` : path);
let people = null;                                  // [{ who, name, online }] from /api/jobs/people
let me = null;                                      // /api/me: { loggedIn, who, full } (who empty = the owner)
const limited = () => !!me?.who && !me.full;        // a person who sees only their own job agent
const loadPeople = async () => (people ??= (await api('/jobs/people').catch(() => ({ people: [] }))).people || []);
const ago = (t) => { const d = (Date.now() - t) / 1000; return d < 90 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`; };

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  if (path.startsWith('/jobs') && who()) { path = withWho(path); if (body) body = { ...body, who: who() }; }   // the person on screen
  const opts = {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Hub': '1' },
    body: body ? JSON.stringify(body) : undefined,
  };
  let r;
  try { r = await fetch('/api' + path, opts); }
  catch {
    // A dropped connection (Wi-Fi blip at home or on the phone): wait a moment and retry once.
    await new Promise((ok) => setTimeout(ok, 1500));
    try { r = await fetch('/api' + path, opts); }
    catch { throw new Error('Could not reach the phone. Check your connection, or the phone may be offline.'); }
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { go('/login'); throw new Error('Log in first.'); }
  if (!r.ok || data.error) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

function busy(btn, fn) {
  return async (e) => {
    e?.preventDefault();
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  };
}

// "250 swiggy dinner" -> { amount: 250, note: 'swiggy dinner' }
const parseQuick = (s) => { const m = /^\s*₹?\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(s || ''); return m ? { amount: Number(m[1]), note: m[2].trim() } : null; };
function quickAdd(placeholder, extra = () => ({})) {
  const input = h('input', { placeholder, 'aria-label': 'Amount and note', autocomplete: 'off', enterkeyhint: 'done' });
  const btn = h('button', { type: 'submit' }, 'Add');
  const form = h('form', { class: 'quick' }, input, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const q = parseQuick(input.value);
    if (!q || !(q.amount > 0)) throw new Error('Start with the amount, e.g. "250 swiggy dinner".');
    const item = await api('/expenses', { method: 'POST', body: { ...q, ...extra() } });
    toast(`Logged ${rupees(item.amount)} · ${item.category}`);
    render();
  }));
  return form;
}

// ---------- live room updates (Server-Sent Events) ----------
let roomStream = null;
let pageTimer = null;                              // per-page refresh (health), cleared on every navigation
let jobsTimer = null;                              // /jobs live polling, cleared on every navigation
function liveRoom(onState) {
  roomStream?.close();
  roomStream = new EventSource('/api/room/stream');
  roomStream.addEventListener('room', (e) => { try { onState(JSON.parse(e.data)); } catch { /* ignore a bad frame */ } });
  // EventSource reconnects by itself; nothing else to do on error.
}

// ---------- phone status chip ----------
async function refreshStatus() {
  try {
    const s = await api('/status');
    const stale = s.updated && Date.now() - s.updated > 5 * 60e3;
    statusEl.classList.toggle('stale', !!stale);
    statusEl.querySelector('span').textContent =
      `S20 ${stale ? 'quiet' : 'online'}` + (s.battery != null ? ` · ${s.charging ? '⚡' : ''}${s.battery}%` : '') + (s.tempC != null ? ` · ${Math.round(s.tempC)}°C` : '');
    statusEl.hidden = false;
    return s;
  } catch { statusEl.hidden = true; return null; }
}
setInterval(() => { if (!statusEl.hidden) refreshStatus(); }, 60e3);
statusEl.setAttribute('role', 'link'); statusEl.setAttribute('tabindex', '0'); statusEl.title = 'Phone health';
statusEl.addEventListener('click', () => go('/health'));
statusEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('/health'); });

// ---------- pages ----------
const pages = {
  async '/'() {
    const month = today().slice(0, 7);
    const [exp, iv, ta, room, li, st, jb, lp] = await Promise.allSettled([
      api(`/expenses?month=${month}`), api('/interview'), api('/tamil'), api('/room'), api('/linkedin'), refreshStatus(), api('/jobs'), api('/laptop'),
    ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));
    const hr = ist().getUTCHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const dateLine = ist().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const up = st?.upSince ? ` · served from a cupboard for ${ago(st.upSince).replace(' ago', '')}` : '';

    // Money
    const todaySpend = exp ? exp.items.filter((i) => i.date === today()).reduce((s, i) => s + i.amount, 0) : 0;
    const cats = exp ? Object.entries(exp.byCategory) : [];
    const money = h('a', { class: 'w', href: '/expenses', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, `Spent · ${shortMonth(month)}`)),
      h('div', { class: 'big' }, exp ? rupees(exp.total) : '—'),
      h('div', { class: 'sub' }, exp ? `today ${rupees(todaySpend)}${cats[0] ? ` · ${cats[0][0]} leads` : ''}` : 'unavailable'),
      cats.length ? h('div', { class: 'minibar' }, cats.slice(0, 6).map(([, v], i) => h('i', { class: 'k' + i, style: `width:${(v / exp.total) * 100}%` }))) : null);

    // Room (live)
    const roomBig = h('div', { class: 'big' }), roomSub = h('div', { class: 'sub' });
    const roomW = h('a', { class: 'w', href: '/room', 'data-link': true }, h('div', { class: 'label' }, h('span', {}, 'Room'), h('span', { class: 'live' }, 'live')), roomBig, roomSub);
    const paintRoom = (s, flash) => {
      roomBig.textContent = s?.lights ? s.lights.toUpperCase() : '—';
      roomSub.replaceChildren(s?.lux != null ? `${Math.round(s.lux)} lux · ` : '', s?.armed ? h('span', { class: 'accent' }, 'armed') : 'alerts off');
      if (flash) { roomW.classList.remove('flash'); void roomW.offsetWidth; roomW.classList.add('flash'); }
    };
    paintRoom(room?.state);
    liveRoom((s) => { const changed = s.lights !== room?.state?.lights; paintRoom(s, changed); if (room) room.state = s; });

    // Interview
    const q = iv?.today;
    const interview = h('div', { class: 'w wide' },
      h('div', { class: 'label' }, h('span', {}, 'Interview · today'), q ? h('span', {}, q.topic) : null),
      q ? h('div', { class: 'q' }, clip(q.question, 150)) : h('div', { class: 'q muted' }, 'No question yet today.'),
      h('div', { class: 'sub' }, q ? (q.score ? `Answered · ${q.score}/5` : 'Not answered yet') : 'A new one arrives at 9 AM'),
      h('a', { class: 'btn small', href: '/interview', 'data-link': true }, q ? (q.score ? 'See feedback' : 'Answer now') : "Get today's question"));

    // Tamil
    const p = ta?.today;
    const tamil = h('a', { class: 'w', href: '/tamil', 'data-link': true }, h('div', { class: 'label' }, h('span', {}, 'Tamil')),
      h('div', { class: 'q' }, p ? p.transliteration : 'Tap for today'), h('div', { class: 'sub' }, p ? clip(p.meaning, 60) : ta?.theme || ''));

    // LinkedIn
    const draft = li?.drafts?.find((d) => d.status === 'draft');
    const linkedin = h('a', { class: 'w', href: '/linkedin', 'data-link': true }, h('div', { class: 'label' }, h('span', {}, 'LinkedIn')),
      h('div', { class: 'big s' }, draft ? 'Draft ready' : 'Fri 7 PM'), h('div', { class: 'sub' }, draft ? `from ${draft.commits} commits` : 'next draft'));

    // Job agent
    const jobsW = h('a', { class: 'w', href: '/jobs', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, 'Job agent'), jb?.installed ? h('span', { class: jb.paused ? '' : 'live' }, jb.paused ? 'paused' : jb.dryRun ? 'dry run' : 'live') : null),
      h('div', { class: 'big' }, jb?.installed ? String(jb.today.applied) : '—'),
      h('div', { class: 'sub' }, jb?.installed ? `applied today · ${jb.total.applied} total${jb.questions.length ? ` · ${jb.questions.length} question${jb.questions.length > 1 ? 's' : ''} for you` : ''}` : 'not running'));

    // Phone health
    const hotPhone = st?.battC >= 43;
    const phoneW = h('a', { class: 'w', href: '/health', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, 'Phone'), hotPhone ? h('span', { class: 'accent' }, 'hot') : null),
      h('div', { class: 'big' + (hotPhone ? ' accent' : '') }, st?.tempC != null ? `${Math.round(st.tempC)}°C` : '—'),
      h('div', { class: 'sub' }, st ? `🔋${st.battery}%${st.charging ? ' ⚡' : ''}${st.availMB ? ` · ${(st.availMB / 1024).toFixed(1)} GB free` : ''}` : 'unavailable'));

    // Laptop server (runs the job agents)
    const lpHot = lp?.online && lp.temps?.cpu >= lp.limits?.warn;
    const lpDown = lp?.online && Object.values(lp.services || {}).some((x) => x !== 'active');
    const laptopW = h('a', { class: 'w', href: '/laptop', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, 'Laptop'), !lp?.online ? h('span', { class: 'accent' }, 'offline') : lpHot ? h('span', { class: 'accent' }, 'hot') : lpDown ? h('span', { class: 'accent' }, 'check') : h('span', { class: 'live' }, 'ok')),
      h('div', { class: 'big' + (lpHot || !lp?.online ? ' accent' : '') }, lp?.online && lp.temps?.cpu != null ? `${Math.round(lp.temps.cpu)}°C` : '—'),
      h('div', { class: 'sub' }, lp?.online ? `CPU ${lp.cpu ?? '—'}% · RAM ${Math.round(100 - (100 * lp.memory.available) / lp.memory.total)}% · 🔋${lp.battery?.percent ?? '—'}%${lp.battery?.plugged ? ' ⚡' : ''}` : 'not reachable'));

    return [
      h('div', { class: 'hello' }, h('h1', {}, `${greet}, ${me?.who ? ((await loadPeople()).find((x) => x.who === me.who)?.name || me.who).split(' ')[0] : 'Guman'}`), h('p', { class: 'lede' }, dateLine + up)),
      h('div', { class: 'grid' }, money, roomW, jobsW, interview, tamil, linkedin, phoneW, laptopW),
      quickAdd('250 swiggy dinner'),
    ];
  },

  // One button: a full 6-scene (~48 s) story as copy-paste prompts for Google Flow. The character/style text is fixed
  // and repeated in every scene, so the series looks the same every time. Nothing is posted from here.
  async '/reels'() {
    const meta = await api('/reels');
    const out = h('div', {});
    const topic = h('input', { placeholder: 'Idea (optional), e.g. "AI deletes the tests"', 'aria-label': 'Idea', autocomplete: 'off', enterkeyhint: 'go' });
    const btn = h('button', { type: 'submit' }, 'Make Flow prompt');
    const form = h('form', { class: 'quick' }, topic, btn);
    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); }
      catch { const ta = h('textarea', {}, text); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      toast(`Copied ${what}`);
    };
    const copyBtn = (text, what, label = 'Copy', ghost = true) => {
      const b = h('button', { class: 'btn small' + (ghost ? ' ghost' : ''), type: 'button', style: 'margin:.5rem .4rem 0 0' }, label);
      b.addEventListener('click', () => copy(text, what));
      return b;
    };
    const show = (p) => {
      const all = p.scenes.map((s) => `SCENE ${s.n} of ${p.scenes.length}\n${s.prompt}`).join('\n\n----------------\n\n');
      const post = `${p.caption}\n\n${p.hashtags.join(' ')}`;
      out.replaceChildren(
        h('div', { class: 'sec' }, p.title),
        h('p', { class: 'lede' }, `${p.logline} · ${p.scenes.length} scenes × ${p.scenes[0].seconds}s = ${p.totalSeconds}s, with dialogue and sound`),
        h('div', { class: 'btns' }, copyBtn(all, 'all scene prompts', 'Copy all prompts', false), copyBtn(post, 'caption and hashtags', 'Copy caption'),
          h('a', { class: 'btn small ghost', href: '/assets/character-ref.png', download: 'character-ref.png', style: 'margin:.5rem .4rem 0 0' }, 'Character image')),
        h('div', { class: 'sec' }, 'In Flow'),
        h('p', { class: 'lede' }, '1) New project → Ingredients to video → add the character image. 2) Paste Scene 1, generate (8 s, with audio). ',
          '3) For scenes 2–6, start from the previous clip\'s last frame (Frames to video / Extend) and paste that scene. ',
          '4) Download the 6 clips and join them in order, then post.'),
        ...p.scenes.map((s) => h('div', { class: 'item', style: 'display:block' },
          h('div', { class: 'main' }, `Scene ${s.n} · ${s.seconds}s`),
          h('p', { class: 'lede' }, s.action),
          ...s.lines.map((l) => h('p', { class: 'lede' }, h('b', {}, l.who + ': '), l.text)),
          h('p', { class: 'lede' }, `Sound: ${s.sfx}`),
          h('details', {}, h('summary', {}, 'Full prompt'), h('pre', { style: 'white-space:pre-wrap;font-size:.8rem;margin:.5rem 0' }, s.prompt)),
          copyBtn(s.prompt, `scene ${s.n} prompt`, `Copy scene ${s.n}`, false))),
        h('div', { class: 'sec' }, 'Post'),
        h('p', { class: 'lede', style: 'white-space:pre-wrap' }, post));
    };
    form.addEventListener('submit', busy(btn, async () => {
      btn.textContent = 'Writing the story…';
      try { show(await api('/reels/prompt', { method: 'POST', body: { topic: topic.value.trim() } })); }
      finally { btn.textContent = 'Make Flow prompt'; }
    }));
    const past = meta.packs.length ? [h('div', { class: 'sec' }, 'Earlier'), h('div', { class: 'chips' }, meta.packs.map((p) => {
      const c = h('a', { class: 'chip', href: '#' }, `${p.title} `, h('small', {}, p.date));
      c.addEventListener('click', busy(null, async (e) => { e?.preventDefault(); show(await api(`/reels/pack?id=${p.id}`)); }));
      return c;
    }))] : [];
    return [h('div', { class: 'hello' }, h('h1', {}, 'Reels'),
      h('p', { class: 'lede' }, 'Press the button for a new story. You get six Google Flow prompts that keep the same two characters, a script with sound, and a caption.')),
      form, out, ...past];
  },

  async '/laptop'() {
    const box = h('div', {}, h('p', { class: 'loading' }, 'Asking the laptop'));
    const gb = (b) => `${(b / 1073741824).toFixed(1)} GB`;
    const tile = (label, big, sub, red) => h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, label)), h('div', { class: 'big' + (red ? ' accent' : '') }, big), h('div', { class: 'sub' }, sub));
    const COMMANDS = [
      ['stop_agents', 'Stop agents', 'Stop both job agents and the browser now? They stay stopped until you press Start.'],
      ['start_agents', 'Start agents', null],
      ['restart_agents', 'Restart agents', 'Restart the job agents? An application in progress is cut off.'],
      ['restart_browser', 'Restart browser', null],
      ['reboot', 'Reboot laptop', 'Reboot the laptop? Everything is back in about 2 minutes.'],
      ['shutdown', 'Shut down', 'Shut the laptop down? It stays off until its charger is unplugged and plugged in again (or someone presses power).'],
    ];
    const run = (cmd, label, ask) => async () => {
      if (ask && !confirm(ask)) return;
      await api('/laptop/command', { method: 'POST', body: { cmd } });
      toast(`${label}: done`);
      setTimeout(() => refresh().catch(() => {}), 2000);
    };
    const paint = (d) => {
      if (!d.online) {
        box.replaceChildren(h('div', { class: 'hello' }, h('h1', {}, 'Laptop'),
          h('p', { class: 'lede' }, h('span', { class: 'accent' }, 'Not reachable. '), d.lastSeen ? `Last seen ${ago(d.lastSeen)}. ` : '',
            'It may be restarting, out of battery, or off WiFi. If it stays down, switch the agents to the phone: job-agent/linux/failover.sh --laptop-dead')));
        return;
      }
      const t = d.temps || {}, L = d.limits || {}, used = d.memory.total - d.memory.available;
      const down = Object.entries(d.services).filter(([, v]) => v !== 'active').map(([k]) => k);
      const issues = [];
      if (t.cpu >= L.warn) issues.push(`the CPU is hot (${Math.round(t.cpu)}°C)`);
      if (d.guard.state !== 'ok') issues.push(d.guard.state === 'held' ? 'the agents are stopped (press Start)' : `the agents were stopped to cool down (${d.guard.reason})`);
      if (down.length) issues.push(`${down.join(', ')} not running`);
      if (d.disk.percent >= 90) issues.push('the disk is almost full');
      if (d.battery && !d.battery.plugged) issues.push(`on battery (${d.battery.percent}%): power cut?`);
      const btns = h('div', { class: 'btns' }, COMMANDS.map(([cmd, label, ask]) => {
        const b = h('button', { class: 'btn small' + (['stop_agents', 'reboot', 'shutdown'].includes(cmd) ? '' : ' ghost'), type: 'button', style: 'margin:0 .4rem .4rem 0' }, label);
        b.addEventListener('click', busy(b, run(cmd, label, ask)));
        return b;
      }));
      box.replaceChildren(
        h('div', { class: 'hello' }, h('h1', {}, 'Laptop'),
          h('p', { class: 'lede' }, issues.length ? h('span', { class: 'accent' }, `Needs attention: ${issues.join('; ')}.`) : 'All good: the laptop is running the job agents.',
            ` · up ${ago(Date.now() - d.uptime * 1000).replace(' ago', '')} · updated ${new Date(d.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`)),
        h('div', { class: 'grid' },
          tile('CPU temp', t.cpu != null ? `${Math.round(t.cpu)}°C` : '—', `warns ${L.warn}°C · stops agents ${L.danger}°C`, t.cpu >= L.warn),
          tile('CPU busy', d.cpu != null ? `${d.cpu}%` : '—', `${d.cpus} threads · load ${d.load[0]}`),
          tile('Memory used', gb(used), `of ${gb(d.memory.total)} · ${Math.round((100 * used) / d.memory.total)}%`, d.memory.available < 1073741824),
          tile('Disk', `${d.disk.percent}%`, `${gb(d.disk.used)} of ${gb(d.disk.size)}`, d.disk.percent >= 90),
          tile('Battery', d.battery ? `${d.battery.percent}%` : '—', d.battery ? `${d.battery.plugged ? 'plugged in' : 'ON BATTERY'} · ${d.battery.status} · holds ${d.battery.health}% of its original charge` : '', d.battery && !d.battery.plugged),
          tile('WiFi', d.wifi.signal != null ? `${d.wifi.signal} dBm` : '—', `${d.wifi.ssid || 'not connected'} · ${d.wifi.ip || ''}`, !d.wifi.ssid || d.wifi.signal < -75),
          tile('Browser', String(d.chromium), 'Chromium processes'),
          tile('Backup to phone', d.lastSync ? ago(d.lastSync) : '—', 'every minute', !d.lastSync || Date.now() - d.lastSync > 10 * 60e3)),
        h('div', { class: 'sec' }, 'Temperatures'),
        h('p', { class: 'lede' }, [['CPU', t.cpu], ['cores', t.cores?.length ? t.cores.map(Math.round).join(' / ') : null], ['chipset', t.chipset], ['WiFi card', t.wifi], ['case surface', t.surface]]
          .filter(([, v]) => v != null).map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v) : v}°C`).join(' · ')),
        h('div', { class: 'sec' }, 'Services'),
        ...Object.entries(d.services).map(([k, v]) => h('div', { class: 'item' }, h('div', { class: 'main' }, k), h('span', { class: v === 'active' ? 'live' : 'accent' }, v))),
        h('p', { class: 'lede' }, `Heat guard: ${d.guard.state === 'ok' ? 'watching' : d.guard.state === 'held' ? 'agents stopped by you' : `agents stopped since ${ago(d.guard.since)} (${d.guard.reason})`}. It stops the agents by itself at ${L.danger}°C and starts them again after 10 minutes below ${L.cool}°C.`),
        h('div', { class: 'sec' }, 'Commands'), btns,
      );
    };
    const refresh = async () => paint(await api('/laptop'));
    await refresh();
    pageTimer = setInterval(() => refresh().catch(() => {}), 10e3);
    return box;
  },

  async '/health'() {
    const box = h('div', {}, h('p', { class: 'loading' }, 'Measuring'));
    const svg = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
    const spark = (title, key, fmt, red) => {
      const pts = (lastHealth?.history || []).filter((x) => x[key] != null);
      if (pts.length < 2) return h('div', { class: 'spark-box' }, h('div', { class: 'label' }, h('span', {}, title)), h('p', { class: 'muted' }, 'Collecting: one point every 5 minutes.'));
      const vals = pts.map((x) => x[key]), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
      const line = svg('polyline', { points: pts.map((x) => `${((x.t - t0) / (t1 - t0 || 1)) * 300},${56 - ((x[key] - lo) / span) * 52}`).join(' ') });
      const chart = svg('svg', { viewBox: '0 0 300 60', preserveAspectRatio: 'none', class: 'spark' + (red ? ' red' : ''), role: 'img', 'aria-label': `${title} over the last 24 hours` });
      chart.append(line);
      return h('div', { class: 'spark-box' }, h('div', { class: 'label' }, h('span', {}, title), h('span', {}, `now ${fmt(vals[vals.length - 1])} · low ${fmt(lo)} · high ${fmt(hi)}`)), chart);
    };
    let lastHealth = null;
    const paint = (d) => {
      lastHealth = d;
      const used = d.mem.totalMB - d.mem.availMB, cpu = d.services.reduce((n, x) => n + x.cpu, 0);
      const issues = [];
      if (d.battC >= 43) issues.push(`the battery is hot (${d.battC}°C)`);
      if (d.mem.availMB < 800) issues.push('memory is tight');
      if (d.disk.freeGB < 10) issues.push('storage is getting full');
      const tile = (label, big, sub, red) => h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, label)), h('div', { class: 'big' + (red ? ' accent' : '') }, big), h('div', { class: 'sub' }, sub));
      const maxMem = Math.max(...d.services.map((x) => x.memMB), 1);
      box.replaceChildren(
        h('div', { class: 'hello' }, h('h1', {}, 'Phone health'),
          h('p', { class: 'lede' }, issues.length ? h('span', { class: 'accent' }, `Needs attention: ${issues.join(', ')}.`) : 'All good: the phone is coping well.',
            ` · up ${ago(d.upSince).replace(' ago', '')} · ${(d.requests || 0).toLocaleString('en-IN')} requests today`)),
        h('div', { class: 'grid' },
          tile('Battery', d.battery != null ? `${d.battery}%` : '—', d.batteryStatus || ''),
          tile('CPU temp', d.cpuC != null ? `${Math.round(d.cpuC)}°C` : '—', 'safe below ~60°C', d.cpuC >= 60),
          tile('Battery temp', d.battC != null ? `${d.battC}°C` : '—', 'keep it below 43°C', d.battC >= 43),
          tile('CPU now', `${(cpu / 100).toFixed(1)}`, `of ${d.cores} cores busy`),
          tile('Memory free', gb(d.mem.availMB), `of ${gb(d.mem.totalMB)} · ${Math.round((used / d.mem.totalMB) * 100)}% used`, d.mem.availMB < 800),
          tile('Swap used', gb(d.mem.swapUsedMB), `of ${gb(d.mem.swapTotalMB)}`),
          tile('Storage free', `${Math.round(d.disk.freeGB)} GB`, `of ${Math.round(d.disk.totalGB)} GB`, d.disk.freeGB < 10),
          tile('Uptime', ago(d.upSince).replace(' ago', ''), 'without a restart')),
        h('div', { class: 'sec' }, "What's using the phone"),
        ...d.services.map((x) => h('div', { class: 'cat' },
          h('div', { class: 'l' }, h('span', {}, x.name), h('span', {}, `${x.memMB.toLocaleString('en-IN')} MB · ${x.cpu}% CPU`)),
          h('div', { class: 't' }, h('i', { class: x.cpu >= 100 ? 'over' : '', style: `width:${(x.memMB / maxMem) * 100}%` })))),
        h('p', { class: 'lede' }, 'Bar = memory. CPU is measured over one second; 100% means one full core (the phone has 8).'),
        h('div', { class: 'sec' }, 'Last 24 hours'),
        spark('CPU temperature', 'cpuC', (v) => `${Math.round(v)}°C`, false),
        spark('Battery temperature', 'battC', (v) => `${Math.round(v)}°C`, true),
        spark('Free memory', 'availMB', (v) => gb(v), false),
        h('div', { class: 'sec' }, 'Keep it healthy'),
        h('p', { class: 'lede' }, 'Turn on Settings → Battery → Protect battery (stops at 85%) and give the cupboard a little air. You get a push if the battery passes 43°C, memory drops under 600 MB or storage under 5 GB.'));
    };
    const load = async () => { try { paint(await api('/health')); } catch (e) { if (!lastHealth) box.replaceChildren(h('p', { class: 'err' }, e.message)); } };
    load();
    pageTimer = setInterval(load, 30e3);
    return [box];
  },

  async '/login'() {
    const me = await api('/me');
    if (me.loggedIn) return go('/');

    const container = h('div', {});
    const h1 = h('h1', {}, 'Log in');
    const lede = h('p', { class: 'lede' }, me.passwordSet ? 'Private tools.' : 'No password set yet. Run set-password.sh from the Mac.');

    // Login form elements
    const user = h('input', { name: 'username', autocomplete: 'username', placeholder: 'Username or email (owner: leave empty)', autocapitalize: 'none' });
    const pw = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
    const err = h('p', { class: 'err' });
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Log in');
    const forgotLink = h('a', { href: '#', class: 'muted', style: 'display:inline-block;margin-top:.85rem;font-size:.85rem;text-decoration:underline' }, 'Forgot password?');
    const loginForm = h('form', { class: 'login' }, user, pw, btn, forgotLink, err);

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try {
        await api('/login', { method: 'POST', body: { user: user.value.trim(), password: pw.value } });
        me = null;
        go('/');
      } catch (x) {
        err.textContent = x.message;
      } finally {
        btn.disabled = false;
      }
    });

    // Forgot password form elements
    const resetUser = h('input', { name: 'username', autocomplete: 'username', placeholder: 'Username or email (owner: leave empty)', autocapitalize: 'none' });
    const resetBtn = h('button', { class: 'btn', type: 'submit' }, 'Send reset link');
    const resetErr = h('p', { class: 'err' });
    const backLink = h('a', { href: '#', class: 'muted', style: 'display:inline-block;margin-top:.85rem;font-size:.85rem;text-decoration:underline' }, '← Back to log in');
    const resetForm = h('form', { class: 'login', style: 'display:none' }, resetUser, resetBtn, backLink, resetErr);
    const resetResult = h('div', { class: 'login', style: 'display:none' });

    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      err.textContent = '';
      resetErr.textContent = '';
      resetResult.style.display = 'none';
      resetResult.replaceChildren();
      loginForm.style.display = 'none';
      resetForm.style.display = 'block';
      h1.textContent = 'Reset password';
      lede.textContent = 'Enter your username or email. We’ll send you a password reset link.';
      resetUser.value = user.value.trim();
      resetUser.focus();
    });

    const showLogin = (e) => {
      if (e) e.preventDefault();
      err.textContent = '';
      resetErr.textContent = '';
      resetForm.style.display = 'none';
      resetResult.style.display = 'none';
      loginForm.style.display = 'block';
      h1.textContent = 'Log in';
      lede.textContent = me.passwordSet ? 'Private tools.' : 'No password set yet. Run set-password.sh from the Mac.';
    };

    backLink.addEventListener('click', showLogin);

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      resetBtn.disabled = true;
      resetErr.textContent = '';
      try {
        const r = await api('/forgot-password', { method: 'POST', body: { user: resetUser.value.trim() } });
        resetForm.style.display = 'none';
        resetResult.style.display = 'block';
        h1.textContent = 'Reset link sent';
        lede.textContent = r.email ? `A reset link was sent to ${r.email} (valid for 2 hours).` : 'A reset link has been created (valid for 2 hours).';

        const directBtn = r.token ? h('button', { class: 'btn', type: 'button', style: 'margin-top:1rem;width:100%' }, 'Choose New Password Now →') : null;
        directBtn?.addEventListener('click', () => go(`/setup?t=${encodeURIComponent(r.token)}`));

        const doneBack = h('a', { href: '#', class: 'muted', style: 'display:inline-block;margin-top:1rem;font-size:.85rem;text-decoration:underline' }, '← Back to log in');
        doneBack.addEventListener('click', showLogin);

        resetResult.replaceChildren(
          h('p', { class: 'lede', style: 'margin-bottom:1rem' }, r.token
            ? 'Since this device is already trusted, you can choose your new password right now, or use the link sent to your email.'
            : 'Please check your email and click the link to choose your new password.'),
          ...(directBtn ? [directBtn] : []),
          doneBack
        );
      } catch (x) {
        resetErr.textContent = x.message;
      } finally {
        resetBtn.disabled = false;
      }
    });

    container.replaceChildren(h1, lede, loginForm, resetForm, resetResult);
    return [container];
  },

  // A one-time add-device link (?t=), made under Devices on a trusted browser: this browser becomes trusted.
  async '/device'() {
    const token = new URLSearchParams(location.search).get('t') || '';
    const ok = await api(`/device?t=${encodeURIComponent(token)}`).then((r) => r.valid).catch(() => false);
    if (!ok) return [h('h1', {}, 'Link expired'), h('p', { class: 'lede' }, 'Add-device links work once, for 15 minutes. Make a new one under Devices on a phone or computer that already uses the hub.')];
    const btn = h('button', { class: 'btn', type: 'button' }, 'Trust this device');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await api('/device', { method: 'POST', body: { token } }); me = null; history.replaceState(null, '', '/login'); render(); }
      catch (x) { toast(x.message, true); btn.disabled = false; }
    });
    return [h('h1', {}, 'Add this device'), h('p', { class: 'lede' }, 'Only trusted phones and computers can open the Tinker hub. Trust this one, then log in as usual.'), btn];
  },

  // Trusted phones and computers: add one with a 15-minute link, or remove a lost one.
  async '/devices'() {
    const box = h('div', {});
    const paint = async () => {
      const { devices } = await api('/devices');
      box.replaceChildren(...devices.map((d) => {
        const x = h('button', { class: 'btn ghost small', type: 'button' }, 'Remove');
        x.addEventListener('click', async () => {
          if (!confirm(d.current ? 'Remove THIS device? It will be locked out until you add it again from another trusted device.' : `Remove ${d.name}? It will be locked out of the hub.`)) return;
          await api(`/devices/${d.id}`, { method: 'DELETE' }); if (d.current) { me = null; location.reload(); } else paint();
        });
        return h('div', { class: 'conn' }, h('span', {}, h('b', {}, d.name, d.current ? ' (this one)' : ''), h('br'),
          h('small', {}, `${d.who === 'owner' ? 'Guman' : d.who ? d.who[0].toUpperCase() + d.who.slice(1) : 'not logged in yet'} · last used ${new Date(d.seen).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`)), x);
      }));
    };
    const out = h('div', {});
    const add = h('button', { class: 'btn', type: 'button' }, 'Add a device');
    add.addEventListener('click', async () => {
      const { token } = await api('/devices/link', { method: 'POST' });
      const url = `${location.origin}/device?t=${token}`;
      const copy = h('button', { class: 'btn ghost', type: 'button' }, 'Copy');
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(url); toast('Copied'); });
      const share = navigator.share ? h('button', { class: 'btn ghost', type: 'button' }, 'Share…') : null;
      share?.addEventListener('click', () => navigator.share({ url }).catch(() => {}));
      out.replaceChildren(h('p', { class: 'lede' }, 'Open this on the new phone or computer within 15 minutes. It works once.'), h('p', { class: 'mono' }, url), h('div', { class: 'row' }, copy, share));
    });
    await paint();
    return [h('h1', {}, 'Devices'), h('p', { class: 'lede' }, 'Only these phones and computers can open the hub; anything else gets a blank page.'), box, h('div', { class: 'sec' }, 'Add one'), add, out];
  },

  // One-time invite link (?t=): the person chooses their own password, then lands on their job agent.
  async '/setup'() {
    const token = new URLSearchParams(location.search).get('t') || '';
    const ok = await api(`/setup?t=${encodeURIComponent(token)}`).then((r) => r.valid).catch(() => false);
    if (!ok) return [h('h1', {}, 'Link expired'), h('p', { class: 'lede' }, 'This link has expired or was already used. If you already set your password, log in instead.'),
      h('a', { class: 'btn', href: '/login', 'data-link': true }, 'Log in')];
    const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10, placeholder: 'Choose a password (10+ characters)' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Repeat it' });
    const err = h('p', { class: 'err' });
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Save and open my dashboard');
    const form = h('form', { class: 'login' }, pw, pw2, btn, err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (pw.value !== pw2.value) { err.textContent = 'The two passwords are different.'; return; }
      btn.disabled = true;
      try { const r = await api('/setup', { method: 'POST', body: { token, password: pw.value } }); me = null; history.replaceState(null, '', '/'); go(r.full ? '/' : `/jobs?who=${encodeURIComponent(r.who)}`, false); }
      catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    });
    return [h('h1', {}, 'Welcome'), h('p', { class: 'lede' }, 'Choose your password for the Tinker hub. Only you will know it. Next time, log in with your username and this password.'), form];
  },

  async '/expenses'() {
    const month = new URLSearchParams(location.search).get('month') || today().slice(0, 7);
    const d = await api(`/expenses?month=${month}`);
    const shift = (n) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
    const isNow = month === today().slice(0, 7);
    const days = isNow ? Number(today().slice(8, 10)) : new Date(Date.UTC(...month.split('-').map(Number), 0)).getUTCDate();

    const csv = h('button', { class: 'btn ghost small', type: 'button', style: 'margin:0' }, 'CSV ↓');
    csv.addEventListener('click', busy(csv, async () => {
      const r = await api(`/expenses/csv?month=${month}`);
      h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.filename }).click();
    }));

    const warn = d.categories.map((c) => [c, d.byCategory[c] || 0, d.budgets[c]]).filter(([, s, b]) => b && s >= b * 0.8)
      .sort((a, b) => b[1] / b[2] - a[1] / a[2])[0];
    const cat = h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'Auto category'), d.categories.map((c) => h('option', { value: c }, c)));
    const date = h('input', { type: 'date', value: isNow ? today() : `${month}-01`, 'aria-label': 'Date' });

    const bars = d.categories.map((c) => {
      const spent = d.byCategory[c] || 0, b = d.budgets[c];
      if (!spent && !b) return null;
      const pct = Math.min(100, b ? (spent / b) * 100 : (spent / (d.total || 1)) * 100);
      return h('div', { class: 'cat' }, h('div', { class: 'l' }, h('span', {}, c), h('span', {}, b ? `${rupees(spent)} / ${rupees(b).slice(1)}` : rupees(spent))),
        h('div', { class: 't' }, h('i', { class: b && spent > b ? 'over' : '', style: `width:${pct}%` })));
    });
    const budgetForm = (() => {
      const c = h('select', { 'aria-label': 'Category' }, d.categories.map((x) => h('option', { value: x }, x)));
      const v = h('input', { type: 'number', min: '0', placeholder: 'Monthly budget (0 = none)', 'aria-label': 'Budget' });
      const b = h('button', { class: 'btn ghost', type: 'submit' }, 'Set');
      const f = h('form', { class: 'row' }, c, v, b);
      f.addEventListener('submit', busy(b, async () => { await api('/expenses/budget', { method: 'POST', body: { category: c.value, amount: v.value } }); toast('Budget saved'); render(); }));
      return h('details', {}, h('summary', {}, 'Set a budget'), f);
    })();

    const rows = d.items.map((i) => {
      const del = h('button', { class: 'x', title: 'Delete', type: 'button', 'aria-label': `Delete ${i.note}` }, '✕');
      del.addEventListener('click', busy(del, async () => {
        if (!confirm(`Delete ${rupees(i.amount)} ${i.note}?`)) return;
        await api(`/expenses/${i.id}`, { method: 'DELETE' }); toast('Deleted'); render();
      }));
      return h('div', { class: 'item' },
        h('div', { class: 'main' }, i.note || '—', h('span', { class: 'tag' }, i.category), h('small', {}, new Date(i.date + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }))),
        h('span', { class: 'num' }, rupees(i.amount)), del);
    });

    return [
      h('div', { class: 'month' }, h('a', { href: `/expenses?month=${shift(-1)}`, 'data-link': true }, '‹ ' + shortMonth(shift(-1))),
        h('span', {}, monthName(month)), isNow ? null : h('a', { href: `/expenses?month=${shift(1)}`, 'data-link': true }, shortMonth(shift(1)) + ' ›'),
        h('span', { class: 'sp' }), csv),
      h('div', { class: 'hello' }, h('h1', {}, rupees(d.total)),
        h('p', { class: 'lede' }, `${d.items.length} entries · ${rupees(d.total / Math.max(1, days))} a day`,
          warn ? h('span', { class: 'accent' }, ` · ${warn[0]} at ${Math.round((warn[1] / warn[2]) * 100)}% of budget`) : '')),
      quickAdd('Amount and note, e.g. 180 uber', () => ({ category: cat.value, date: date.value })),
      h('details', {}, h('summary', {}, 'Category or date'), h('div', { class: 'row', style: 'display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap' }, cat, date)),
      h('div', { class: 'sec' }, 'By category'), ...(bars.some(Boolean) ? bars : [h('p', { class: 'muted' }, 'Nothing yet.')]), budgetForm,
      h('div', { class: 'sec' }, 'Entries'), rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'Nothing logged this month.'),
      h('p', { class: 'lede', style: 'margin-top:1.5rem' }, 'Also by Siri ("Log expense") or a text like "250 swiggy dinner" to your ntfy expense topic.'),
    ];
  },

  async '/interview'() {
    const d = await api('/interview');
    const q = d.today;
    const out = [h('div', { class: 'hello' }, h('h1', {}, 'Interview'), h('p', { class: 'lede' }, 'A question every morning at 9. Weak topics come back sooner.'))];
    if (!q) {
      const b = h('button', { class: 'btn', type: 'button' }, "Get today's question");
      b.addEventListener('click', busy(b, async () => { await api('/interview/new', { method: 'POST' }); render(); }));
      out.push(b);
    } else {
      out.push(h('div', { class: 'label' }, h('span', {}, q.topic)), h('div', { class: 'box q' }, q.question));
      if (q.score) {
        out.push(h('div', { class: 'score' }, `${q.score}/5`),
          h('div', { class: 'sec' }, 'What was good'), h('p', {}, q.good), h('div', { class: 'sec' }, 'Missing'), h('p', {}, q.missing),
          h('div', { class: 'sec' }, 'Model answer'), h('div', { class: 'box' }, q.model));
      } else {
        const ta = h('textarea', { placeholder: 'Type your answer as you would say it in the interview…' });
        const b = h('button', { class: 'btn', type: 'submit' }, 'Grade my answer');
        const f = h('form', {}, ta, h('div', { class: 'btns' }, b));
        f.addEventListener('submit', busy(b, async () => { await api('/interview/answer', { method: 'POST', body: { id: q.id, answer: ta.value } }); render(); }));
        out.push(f);
      }
    }
    if (d.topics.length) out.push(h('div', { class: 'sec' }, 'Topics · weakest first'),
      ...d.topics.map((t) => h('div', { class: 'cat' }, h('div', { class: 'l' }, h('span', {}, t.topic), h('span', {}, `${t.avg.toFixed(1)}/5 · ${t.n}×`)),
        h('div', { class: 't' }, h('i', { class: t.avg < 3 ? 'over' : '', style: `width:${(t.avg / 5) * 100}%` })))));
    const past = d.history.filter((x) => x.score && x.id !== q?.id);
    if (past.length) out.push(h('div', { class: 'sec' }, 'History'), h('div', { class: 'list' }, past.map((x) =>
      h('div', { class: 'item' }, h('div', { class: 'main' }, clip(x.question, 120), h('small', {}, `${x.date} · ${x.topic}`)), h('span', { class: 'num accent' }, `${x.score}/5`)))));
    return out;
  },

  async '/linkedin'() {
    const d = await api('/linkedin');
    const gen = h('button', { class: 'btn', type: 'button' }, 'Draft from this week');
    gen.addEventListener('click', busy(gen, async () => { await api('/linkedin/draft', { method: 'POST' }); toast('Draft ready'); render(); }));
    const drafts = d.drafts.map((x) => {
      const ta = h('textarea', {}, x.post);
      const set = (status, msg) => busy(null, async () => { await api('/linkedin/status', { method: 'POST', body: { id: x.id, status, post: ta.value } }); toast(msg); render(); });
      const copy = h('button', { class: 'btn', type: 'button' }, 'Approve & copy');
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(ta.value); await set('approved', 'Copied. Paste it into LinkedIn')(); });
      const skip = h('button', { class: 'btn ghost', type: 'button' }, 'Skip');
      skip.addEventListener('click', set('skipped', 'Skipped'));
      return h('div', { style: 'margin-bottom:2rem' },
        h('div', { class: 'label' }, h('span', {}, `${x.date} · ${x.commits} commits`), h('span', { class: x.status === 'draft' ? 'accent' : '' }, x.status)),
        h('div', { style: 'margin-top:.5rem' }, ta), x.status === 'draft' ? h('div', { class: 'btns' }, copy, skip) : null);
    });
    return [h('div', { class: 'hello' }, h('h1', {}, 'LinkedIn'),
      h('p', { class: 'lede' }, 'A draft every Friday at 7 PM from your commits. Nothing is posted automatically: approve, copy, paste into LinkedIn.')),
      h('div', { class: 'btns', style: 'margin-bottom:1.5rem' }, gen), ...(drafts.length ? drafts : [h('p', { class: 'muted' }, 'No drafts yet.')])];
  },

  async '/tamil'() {
    const d = await api('/tamil');
    const b = h('button', { class: 'btn ghost', type: 'button' }, d.today ? 'Another phrase' : "Get today's phrase");
    b.addEventListener('click', busy(b, async () => { await api('/tamil/new', { method: 'POST' }); render(); }));
    const t = d.today;
    const reply = t?.reply && (typeof t.reply === 'object'
      ? [t.reply.transliteration, t.reply.tamil && `(${t.reply.tamil})`, t.reply.meaning && `= ${t.reply.meaning}`].filter(Boolean).join(' ') : t.reply);
    return [
      h('div', { class: 'hello' }, h('h1', {}, 'Tamil'), h('p', { class: 'lede' }, `This week: ${d.theme}. A new phrase at 8 AM; quiz on Sundays.`)),
      t ? h('div', { class: 'box' }, h('div', { class: 'phrase' }, t.transliteration), h('div', { class: 'muted', style: 'font-size:1.15rem;margin:.25rem 0 .6rem' }, t.tamil),
        h('div', { style: 'font-weight:600' }, t.meaning), h('div', { class: 'muted', style: 'margin-top:.4rem' }, t.when),
        reply ? h('div', { style: 'margin-top:.6rem' }, h('span', { class: 'label' }, 'Reply '), reply) : null) : null,
      h('div', { class: 'btns' }, b),
      h('div', { class: 'sec' }, 'Earlier'),
      h('div', { class: 'list' }, d.phrases.filter((p) => p.date !== t?.date).map((p) =>
        h('div', { class: 'item' }, h('div', { class: 'main' }, h('b', {}, p.transliteration), h('small', {}, p.tamil)), h('span', { class: 'muted', style: 'text-align:right' }, p.meaning)))),
    ];
  },

  async '/jobs'() {
    const [d, bar] = await Promise.all([api('/jobs'), personBar()]);
    if (!d.installed) return [bar, h('h1', {}, 'Jobs'), h('p', { class: 'lede' }, 'This job agent has not started yet.')];
    const params = new URLSearchParams(location.search);
    const filter = params.get('show') || 'matches';
    const term = params.get('q') || '';
    const act = (body, msg) => async () => { await api('/jobs/action', { method: 'POST', body }); toast(msg); render(); };
    const when = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

    // ---- live strip: what the agent is doing right now (polled every 5 s while this page is open)
    const nowText = h('span', {}), nowAgo = h('small', { class: 'muted' });
    const tiles = { applied: h('div', { class: 'big' }), found: h('div', { class: 'big' }), matched: h('div', { class: 'big' }), replies: h('div', { class: 'big' }) };
    const paint = (x) => {
      nowText.textContent = x.paused ? 'Paused' : x.now?.text || 'Idle';
      nowAgo.textContent = x.now?.at ? ` · ${ago(x.now.at)}` : '';
      for (const k of Object.keys(tiles)) tiles[k].textContent = x.today[k];
    };
    paint(d);
    jobsTimer = setInterval(async () => { try { paint(await api('/jobs')); } catch { /* next tick */ } }, 5000);

    const mode = h('div', { class: 'btns' },
      (() => { const b = h('button', { class: 'btn ghost small', type: 'button' }, d.paused ? 'Resume' : 'Pause');
        b.addEventListener('click', busy(b, act({ action: d.paused ? 'resume' : 'pause' }, d.paused ? 'Applying again' : 'Paused'))); return b; })(),
      (() => { const b = h('button', { class: 'btn small', type: 'button' }, d.dryRun ? 'Go live' : 'Back to dry run');
        b.addEventListener('click', busy(b, async () => {
          if (d.dryRun && !confirm('Go live? The agent will submit real applications for jobs scoring 75+, within the daily caps.')) return;
          await act({ action: d.dryRun ? 'live' : 'dry' }, d.dryRun ? 'Live: applications will be submitted' : 'Dry run: forms filled, never submitted')();
        })); return b; })());

    // ---- needs you: open questions (answer inline) + jobs to finish by hand
    const questions = d.questions.map((x) => {
      const input = h('input', { placeholder: 'Your answer', 'aria-label': `Answer to ${x.question}`, autocomplete: 'off' });
      const b = h('button', { type: 'submit' }, 'Save');
      const f = h('form', { class: 'quick', style: 'margin-top:.4rem' }, input, b);
      f.addEventListener('submit', busy(b, async () => {
        if (!input.value.trim()) throw new Error('Type an answer first.');
        await act({ action: 'answer', id: x.id, answer: input.value }, 'Saved. Remembered for every future application.')();
      }));
      return h('div', { class: 'item', style: 'display:block' }, h('div', { class: 'main' }, h('b', {}, `Q${x.id} `), x.question,
        x.waiting > 1 ? h('span', { class: 'tag red' }, `${x.waiting} waiting`) : null), f);
    });
    const attention = d.attention.map((j) => h('div', { class: 'item' },
      h('div', { class: 'main' }, h('a', { href: `/jobs/job?id=${encodeURIComponent(j.id)}`, 'data-link': true }, `${j.title} · ${j.company}`),
        h('span', { class: 'tag' + (j.status === 'interview' ? ' red' : '') }, j.status === 'manual' ? 'apply yourself' : j.status === 'claimed' ? 'you are applying' : j.status === 'captcha' ? 'captcha · finish on Mac' : j.status.replace('_', ' ')),
        h('small', {}, clip(j.status_note && !/\.png$/.test(j.status_note) ? j.status_note : j.location || '', 90))),
      j.score != null ? h('span', { class: 'num' }, `${j.score}%`) : null));

    // ---- 14-day applied chart
    const days = [...Array(14)].map((_, i) => new Date(Date.now() + 5.5 * 3600e3 - (13 - i) * 86400e3).toISOString().slice(0, 10));
    const per = Object.fromEntries(d.days.map((x) => [x.d, x.n]));
    const peak = Math.max(1, ...days.map((x) => per[x] || 0));
    const chart = h('div', { class: 'spark', role: 'img', 'aria-label': 'Applications per day, last 14 days' },
      days.map((x) => h('i', { title: `${x}: ${per[x] || 0}`, style: `height:${Math.max(3, ((per[x] || 0) / peak) * 100)}%` })));

    // ---- pipeline list with filters
    const FILTERS = [['matches', 'Scored'], ['queued', 'Queue'], ['ready', 'Dry-run ok'], ['applied', 'Applied'], ['interview', 'Interview'],
      ['captcha', 'CAPTCHA'], ['manual', 'Apply yourself'], ['claimed', 'Claimed'], ['needs_answer', 'Waiting on you'], ['rejected', 'Rejected'], ['all', 'All']];
    const list = await api(`/jobs/list?status=${filter}&q=${encodeURIComponent(term)}`);
    const search = h('input', { placeholder: 'Search title or company', value: term, 'aria-label': 'Search jobs' });
    const sform = h('form', { class: 'row' }, search);
    sform.addEventListener('submit', (e) => { e.preventDefault(); go(`/jobs?show=${filter}&q=${encodeURIComponent(search.value)}`); });
    const rows = list.jobs.map((j) => h('div', { class: 'item' },
      h('div', { class: 'main' }, h('a', { href: `/jobs/job?id=${encodeURIComponent(j.id)}`, 'data-link': true }, j.title),
        h('span', { class: 'tag' }, j.source), j.status !== filter ? h('span', { class: 'tag' }, j.status.replace('_', ' ')) : null,
        h('small', {}, `${j.company} · ${clip(j.location || '', 50)} · ${j.applied_at ? 'applied ' + ago(j.applied_at) : 'found ' + ago(j.found_at)}`)),
      h('span', { class: 'num' + (j.score >= 75 ? ' accent' : '') }, j.score != null ? `${j.score}%` : '—')));

    const learned = d.total.learned;
    return [
      bar,
      h('div', { class: 'hello' }, h('h1', {}, who() && d.name ? `Jobs · ${d.name}` : 'Jobs'),
        h('p', { class: 'lede' }, h('span', { class: 'live' }, 'live'), ' ', nowText, nowAgo, ' · ', h('a', { href: '/jobs/live', 'data-link': true }, 'open terminal')),
        h('p', { class: 'lede' }, d.dryRun ? h('span', { class: 'accent' }, 'Dry run: forms are filled but never submitted. ') : `Live: applying to jobs scoring ${d.minScore || 65}+. `,
          `${d.total.found} jobs seen · ${d.total.applied} applied · ${d.total.interviews} in interview stage · ${learned} answers learned`)),
      mode,
      h('div', { class: 'grid', style: 'margin-top:1rem' },
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Applied today')), tiles.applied),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Found today')), tiles.found),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, `Matches ${d.minScore || 65}+`)), tiles.matched),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Replies')), tiles.replies)),
      h('div', { class: 'sec' }, 'Applied · last 14 days'), chart,
      questions.length || attention.length ? h('div', { class: 'sec' }, 'Needs you') : null,
      questions.length ? h('div', { class: 'list' }, questions) : null,
      attention.length ? h('div', { class: 'list', style: 'margin-top:.5rem' }, attention) : null,
      h('div', { class: 'sec' }, 'Pipeline'),
      h('div', { class: 'chips' }, FILTERS.map(([k, label]) => h('a', { href: `/jobs?show=${k}`, 'data-link': true, class: 'chip' + (k === filter ? ' on' : '') },
        label, d.byStatus[k] ? h('small', {}, ` ${d.byStatus[k]}`) : null))),
      sform,
      rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'Nothing here yet.'),
      h('div', { class: 'sec' }, 'Recruiter mail'),
      d.mail.length ? h('div', { class: 'list' }, d.mail.map((m) => h('div', { class: 'item' },
        h('div', { class: 'main' }, m.subject || '(no subject)', h('span', { class: 'tag' + (['interview', 'offer'].includes(m.category) ? ' red' : '') }, m.category),
          h('small', {}, `${m.from_addr} · ${when(m.at)}`))))) : h('p', { class: 'muted' }, 'No recruiter mail yet (or the mailbox is not connected).'),
      h('div', { class: 'sec' }, 'Activity'),
      d.events.length ? h('div', { class: 'list' }, d.events.map((e) => h('div', { class: 'item' },
        h('div', { class: 'main' }, e.text, h('small', {}, `${e.kind} · ${when(e.at)}`))))) : h('p', { class: 'muted' }, 'Nothing yet.'),
      h('div', { class: 'sec' }, 'Sources'),
      h('div', { class: 'list' }, d.bySource.map((s) => h('div', { class: 'item' }, h('div', { class: 'main' }, s.source), h('span', { class: 'num' }, `${s.applied || 0} / ${s.n}`)))),
      h('p', { class: 'lede', style: 'margin-top:1.5rem' }, h('a', { href: '/jobs/live', 'data-link': true }, 'Live: what the agent is doing right now (log and browser) →')),
      h('p', { class: 'lede' }, h('a', { href: '/jobs/referrals', 'data-link': true }, 'Referrals: people asked at target companies →')),
      h('p', { class: 'lede' }, h('a', { href: '/jobs/errors', 'data-link': true }, 'Errors: what failed and why →')),
      h('p', { class: 'lede' }, h('a', { href: '/jobs/memory', 'data-link': true }, 'What the agent knows about you →')),
    ];
  },

  async '/jobs/referrals'() {
    const d = await api('/jobs/referrals');
    const act = (body, msg) => async () => { const r = await api('/jobs/action', { method: 'POST', body }); toast(r.message || msg); render(); };
    const STAGES = { drafted: 'waiting for you', approved: 'approved, sending soon', invited: 'invite sent', accepted: 'accepted',
      followup_drafted: 'referral message waiting for you', followup_approved: 'message approved', followup_sent: 'referral asked',
      replied: 'replied', referred: 'referred 🎉', skipped: 'skipped', failed: 'failed' };
    const companies = h('textarea', { 'aria-label': 'Target companies, one per line', style: 'min-height:7rem' }, d.companies.join('\n'));
    const saveCo = h('button', { class: 'btn small', type: 'button' }, 'Save companies');
    saveCo.addEventListener('click', busy(saveCo, act({ action: 'ref_companies', answer: companies.value }, 'Companies saved')));
    const row = (r) => {
      const waiting = r.stage === 'drafted' || r.stage === 'followup_drafted';
      const original = ((r.stage === 'drafted' ? r.note : r.followup) || '').trim();
      const text = h('textarea', { style: 'min-height:6rem;margin-top:.4rem' }, waiting ? original : '');
      const send = h('button', { class: 'btn small', type: 'button' }, '✓ Send');
      send.addEventListener('click', busy(send, act({ action: 'ref_decide', id: r.id, answer: text.value.trim() === original ? 'ok' : text.value }, 'Approved')));
      const skip = h('button', { class: 'btn ghost small', type: 'button' }, 'Skip');
      skip.addEventListener('click', busy(skip, act({ action: 'ref_decide', id: r.id, answer: 'skip' }, 'Skipped')));
      return h('div', { class: 'item', style: 'display:block' },
        h('div', { class: 'main' }, h('a', { href: r.profile, target: '_blank', rel: 'noopener noreferrer' }, r.person),
          r.alumni ? h('span', { class: 'tag red' }, 'SRM alum') : null, h('span', { class: 'tag' }, STAGES[r.stage] || r.stage),
          h('small', {}, `${r.company}${r.job_title ? ` · ${r.job_title}` : ''}${r.headline ? ` · ${clip(r.headline, 90)}` : ''}${r.email ? ` · ${r.email}` : ''}${r.reason ? ` · ${r.reason}` : ''}`)),
        waiting ? h('div', {}, text, h('div', { class: 'btns' }, send, skip)) : null);
    };
    const s = d.byStage;
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', {}, 'Referrals'),
        h('p', { class: 'lede' }, `Every message waits for your OK. Up to ${d.perDay} a day, spaced out, 9 AM–9 PM. `
          + `${(s.drafted || 0) + (s.followup_drafted || 0)} waiting for you · ${s.invited || 0} invites out · ${s.followup_sent || 0} referral asks sent · ${s.referred || 0} referred`)),
      h('div', { class: 'sec' }, 'Waiting for you, then everything else'),
      d.rows.length ? h('div', { class: 'list' }, d.rows.map(row)) : h('p', { class: 'muted' }, 'Nothing yet: the agent searches companies hourly between 9 AM and 9 PM.'),
      h('div', { class: 'sec' }, 'Target companies (plus any company where a job scores 80%+)'),
      companies, h('div', { class: 'btns' }, saveCo),
    ];
  },

  async '/jobs/errors'() {
    const [d, bar] = await Promise.all([api('/jobs/errors'), personBar()]);
    const when = (t) => new Date(typeof t === 'number' ? t : Date.parse(t)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const evidence = (shot) => {
      if (!shot) return null;
      const box = h('div', {});
      const btn = (label, kind) => { const b = h('button', { class: 'btn ghost small', type: 'button', style: 'margin:.3rem .3rem 0 0' }, label);
        b.addEventListener('click', busy(b, async () => {
          const f = await api(`/jobs/evidence?kind=${kind}&shot=${encodeURIComponent(shot)}`);
          if (kind === 'png') box.replaceChildren(h('img', { src: `data:image/png;base64,${f.data}`, alt: 'Screenshot', style: 'max-width:100%;border:1px solid var(--line);margin-top:.5rem' }));
          else { const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)); h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'text/plain' })), download: f.name.replace(/\.html$/, '.txt') }).click(); }
        })); return b; };
      return h('div', {}, btn('Screenshot', 'png'), btn('Page HTML ↓', 'html'), box);
    };
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      bar,
      h('div', { class: 'hello' }, h('h1', {}, 'Errors'),
        h('p', { class: 'lede' }, `${d.total} errors in the last 7 days · last 24 h: ${d.attempts24h} application attempts, ${d.applied24h} applied`)),
      h('div', { class: 'sec' }, 'By type · newest first'),
      d.groups.length ? h('div', { class: 'list' }, d.groups.map((g) => h('div', { class: 'item', style: 'display:block' },
        h('div', { class: 'main' }, h('b', {}, `${g.count}× `), `${g.last.kind}: ${clip(g.last.message, 220)}`,
          h('span', { class: 'tag' + (g.lastHour ? ' red' : '') }, g.last.src), g.lastHour ? h('span', { class: 'tag red' }, `${g.lastHour} in the last hour`) : null,
          h('small', {}, `last ${when(g.last.at)} · first ${when(g.first)}${g.last.ctx?.job ? ` · job ${g.last.ctx.job}` : ''}`)),
        g.last.stack ? h('details', {}, h('summary', {}, 'Stack trace'), h('pre', { class: 'term', style: 'height:auto;max-height:18rem' }, g.last.stack)) : null))) : h('p', { class: 'muted' }, 'No errors recorded. 🎉'),
      h('div', { class: 'sec' }, 'Recent attempts that did not apply'),
      d.attempts.length ? h('div', { class: 'list' }, d.attempts.map((a) => h('div', { class: 'item', style: 'display:block' },
        h('div', { class: 'main' }, h('a', { href: `/jobs/job?id=${encodeURIComponent(a.job_id)}`, 'data-link': true }, `${a.title || a.job_id}${a.company ? ` · ${a.company}` : ''}`),
          h('span', { class: 'tag' }, a.status), h('small', {}, `${when(a.at)} · ${Math.round((a.ms || 0) / 1000)} s${a.filled != null ? ` · filled ${a.filled}` : ''}${a.unknown ? ` · ${a.unknown} unanswered` : ''}${a.reason ? ` · ${clip(a.reason, 160)}` : ''}`)),
        evidence(a.shot)))) : h('p', { class: 'muted' }, 'None yet.'),
    ];
  },

  async '/jobs/live'() {
    const term = h('div', { class: 'term', role: 'log', 'aria-live': 'off' });
    const bar = await personBar();
    const screenImg = h('img', { class: 'screen', alt: "Live view of the agent's browser" });
    const screenCap = h('p', { class: 'muted', style: 'font-size:.8rem;margin:.4rem 0 0' }, 'Waiting for the agent…');
    let shotAt = 0;
    const paintScreen = async () => {
      const r = await api(`/jobs/screen?since=${shotAt}`);
      if (!r.working) { screenImg.hidden = true; screenCap.textContent = 'The browser is idle right now: it shows up here whenever the agent is searching or applying.'; return; }
      if (r.image) { screenImg.src = `data:image/jpeg;base64,${r.image}`; shotAt = r.shotAt; }
      screenImg.hidden = false;
      const task = String(r.task || '').replace(/^apply_/, 'applying via ').replace(/_/g, ' ');
      screenCap.textContent = `${task} · ${String(r.url || '').replace(/^https?:\/\//, '').slice(0, 90)} · ${ago(r.at)}`;
    };
    const now = h('span', {}), stat = { searches: h('div', { class: 'big' }), boards: h('div', { class: 'big' }), found: h('div', { class: 'big' }), applied: h('div', { class: 'big' }) };
    let offset = null;
    const time = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
    const add = (lines) => {
      const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 30;
      for (const l of lines) {
        const msg = l.slice(25);
        const cls = /applied|"status":"applied"|✅|done:/i.test(msg) ? 'ok' : /error|failed|timeout|closed/i.test(msg) ? 'bad' : /^🌐/.test(msg) ? 'web' : '';
        term.append(h('div', { class: cls }, h('i', {}, time(l.slice(0, 24)) + '  '), msg));
      }
      while (term.childNodes.length > 600) term.firstChild.remove();
      if (stick) term.scrollTop = term.scrollHeight;
    };
    const tick = async () => {
      const [log, st] = await Promise.all([api(`/jobs/log${offset == null ? '' : `?since=${offset}`}`), api('/jobs')]);
      offset = log.offset; add(log.lines);
      stat.searches.textContent = log.searchesToday; stat.boards.textContent = log.boardsToday;
      stat.found.textContent = st.today.found; stat.applied.textContent = st.today.applied;
      now.textContent = st.paused ? 'Paused' : st.now?.text || 'Idle';
    };
    await tick();
    await paintScreen().catch(() => {});
    jobsTimer = setInterval(() => { tick().catch(() => {}); paintScreen().catch(() => {}); }, 3000);
    const tile = (label, el) => h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, label)), el);
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      bar,
      h('div', { class: 'hello' }, h('h1', {}, 'Live'), h('p', { class: 'lede' }, h('span', { class: 'live' }, 'now'), ' ', now)),
      h('div', { class: 'grid' }, tile('Searches today', stat.searches), tile('Sources today', stat.boards), tile('Jobs found today', stat.found), tile('Applied today', stat.applied)),
      h('div', { class: 'sec' }, 'Browser · live'), screenImg, screenCap,
      h('div', { class: 'sec' }, 'What the agent is doing'), term,
    ];
  },

  async '/jobs/job'() {
    const id = new URLSearchParams(location.search).get('id');
    const j = await api(`/jobs/detail?id=${encodeURIComponent(id)}`);
    const act = (action, msg) => busy(null, async () => { await api('/jobs/action', { method: 'POST', body: { action, id: j.id } }); toast(msg); render(); });
    const file = (kind) => busy(null, async () => {
      const f = await api(`/jobs/file?id=${encodeURIComponent(j.id)}&kind=${kind}`);
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: f.type }));
      if (kind === 'resume') h('a', { href: url, download: f.name }).click();
      else shot.replaceChildren(h('img', { src: `data:${f.type};base64,${f.data}`, alt: 'Screenshot of the application', style: 'max-width:100%;border:1px solid var(--line)' }));
    });
    const shot = h('div', {});
    const btn = (label, fn, ghost = true) => { const b = h('button', { class: 'btn' + (ghost ? ' ghost' : ''), type: 'button' }, label); b.addEventListener('click', fn); return b; };
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', { style: 'font-size:clamp(1.6rem,4vw,2.4rem)' }, j.title),
        h('p', { class: 'lede' }, `${j.company} · ${j.location || ''} · ${j.source} · ${j.status.replace('_', ' ')}${j.applied_at ? ' · applied ' + ago(j.applied_at) : ''}`)),
      j.score != null ? h('div', {}, h('span', { class: 'score' }, `${j.score}%`), h('p', { class: 'muted' }, j.score_reasons)) : null,
      h('div', { class: 'btns' },
        h('a', { class: 'btn', href: j.apply_url || j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open job ↗'),
        j.hasResume ? btn('Tailored resume ↓', file('resume')) : null,
        j.hasShot ? btn('Screenshot', file('shot')) : null,
        !['applied', 'interview', 'claimed', 'applying'].includes(j.status) ? btn("I'm applying", act('claim', 'Claimed: the agent will leave this one to you')) : null,
        !['applied', 'interview', 'queued'].includes(j.status) ? btn(j.status === 'claimed' ? 'Hand back to agent' : 'Apply anyway', act('queue', 'Queued')) : null,
        ['manual', 'claimed'].includes(j.status) ? btn('I applied', act('applied', 'Marked as applied')) : null,
        !['applied', 'interview', 'skipped'].includes(j.status) ? btn('Skip', act('skip', 'Skipped')) : null),
      shot,
      j.status_note && !/\.png$/.test(j.status_note) ? h('p', { class: 'muted' }, j.status_note) : null,
      ...(() => {
        // Every answer the agent prepared for this application, ready to copy into the form.
        const fa = (() => { try { return JSON.parse(j.form_answers || 'null'); } catch { return null; } })();
        if (!fa) return [];
        const copy = (text) => async () => { await navigator.clipboard.writeText(text); toast('Copied'); };
        return [h('div', { class: 'sec' }, 'Prefilled answers for this form'),
          h('div', { class: 'list' }, fa.filled.map((f) => {
            const b = h('button', { class: 'btn ghost small', type: 'button', style: 'margin:0' }, 'Copy');
            b.addEventListener('click', copy(f.value));
            return h('div', { class: 'item' }, h('div', { class: 'main' }, f.label, h('small', {}, clip(f.value, 160))), b);
          })),
          fa.open.length ? h('p', { class: 'muted' }, `Not answered yet: ${fa.open.join(' · ')}`) : null];
      })(),
      j.emails.length ? h('div', { class: 'sec' }, 'Emails') : null,
      ...j.emails.map((m) => h('div', { class: 'box' }, h('div', { class: 'label' }, h('span', {}, `${m.direction === 'in' ? 'From ' + m.from_addr : 'You replied'} · ${m.category}`)),
        h('b', {}, m.subject), '\n\n', clip(m.body, 1500))),
      h('div', { class: 'sec' }, 'Description'), h('div', { class: 'box', style: 'border-left-color:var(--line);font-size:.88rem' }, j.description || '—'),
    ];
  },

  async '/jobs/memory'() {
    const d = await api('/jobs/memory');
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', {}, 'Memory'), h('p', { class: 'lede' }, 'Every question the agent has answered for you. "derived" ones came from your resume; forget any that look wrong and it will ask you next time.')),
      h('div', { class: 'list' }, d.answers.map((a) => {
        const x = h('button', { class: 'x', type: 'button', title: 'Forget', 'aria-label': `Forget ${a.question}` }, '✕');
        x.addEventListener('click', busy(x, async () => { if (!confirm(`Forget the answer to "${a.question}"?`)) return; await api('/jobs/action', { method: 'POST', body: { action: 'forget', id: a.id } }); toast('Forgotten'); render(); }));
        return h('div', { class: 'item' }, h('div', { class: 'main' }, a.question, h('small', {}, `${a.answer} · ${a.source}${a.uses ? ` · used ${a.uses}×` : ''}`)), x);
      })),
    ];
  },

  async '/room'() {
    const d = await api('/room');
    let s = d.state || {};
    const time = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const lights = h('div', { class: 'big' }), lux = h('div', { class: 'big' }), alerts = h('div', { class: 'big' });
    const lightW = h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Lights'), h('span', { class: 'live' }, 'live')), lights);
    const toggle = h('button', { class: 'btn', type: 'button' });
    const list = h('div', { class: 'list' });
    const paint = (events, flash) => {
      lights.textContent = s.lights ? s.lights.toUpperCase() : '—';
      lux.textContent = s.lux == null ? '—' : Math.round(s.lux);
      alerts.replaceChildren(s.armed ? h('span', { class: 'accent' }, 'Armed') : 'Off');
      toggle.textContent = s.armed ? "Disarm (I'm home)" : "Arm (I'm leaving)";
      if (events) list.replaceChildren(...events.map((e) => h('div', { class: 'item' }, h('div', { class: 'main' }, `${e.kind} ${e.value}`, e.armed ? h('span', { class: 'tag red' }, 'armed') : null), h('span', { class: 'muted' }, time(e.t)))));
      if (flash) { lightW.classList.remove('flash'); void lightW.offsetWidth; lightW.classList.add('flash'); }
    };
    toggle.addEventListener('click', busy(toggle, async () => { await api('/room/arm', { method: 'POST', body: { armed: !s.armed } }); toast(s.armed ? 'Disarming…' : 'Arming…'); }));
    paint(d.events);
    liveRoom((n) => { const changed = n.lights !== s.lights; s = n; paint(n.events, changed); });
    return [
      h('div', { class: 'hello' }, h('h1', {}, 'Room'), h('p', { class: 'lede' }, 'Live from the phone\'s light sensor. Alerts are pushed only while armed.')),
      h('div', { class: 'grid' }, lightW, h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Lux now')), lux),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Alerts')), alerts)),
      h('div', { class: 'btns', style: 'margin-top:1rem' }, toggle),
      h('div', { class: 'sec' }, 'Recent changes'), list,
    ];
  },
};

// ---------- router ----------
const TITLES = { '/device': 'Add device', '/devices': 'Devices', '/setup': 'Welcome', '/laptop': 'Laptop', '/reels': 'Reels', '/jobs/errors': 'Errors', '/jobs/referrals': 'Referrals', '/health': 'Phone health', '/jobs/live': 'Live', '/jobs': 'Jobs', '/jobs/job': 'Job', '/jobs/memory': 'Memory', '/': 'Tinker hub', '/login': 'Log in', '/expenses': 'Money', '/interview': 'Interview', '/linkedin': 'LinkedIn', '/tamil': 'Tamil', '/room': 'Room' };
function go(path, keepWho = true) {
  if (keepWho && path.startsWith('/jobs') && who() && !/[?&]who=/.test(path)) path = withWho(path);   // stay on the same person's agent
  history.pushState(null, '', path); render();
}
function markTabs() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  tabs.querySelectorAll('a').forEach((a) => {
    const u = new URL(a.href);
    const on = path.startsWith('/jobs') ? u.pathname === '/jobs' && (u.searchParams.get('who') || '') === who() : u.pathname === path;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    if (on && tabs.scrollWidth > tabs.clientWidth) a.scrollIntoView({ inline: 'center', block: 'nearest' });   // phone: bring the tab into view
    a.hidden = limited() && !(u.pathname === '/jobs' && u.searchParams.get('who') === me.who);   // a limited person: only their own tab
  });
}
// A tab per other person's job agent, next to Jobs (added once, after login).
let peopleTabs = false;
async function addPeopleTabs() {
  if (peopleTabs) return;
  peopleTabs = true;
  const list = (await loadPeople()).filter((p) => p.who);
  const jobsTab = tabs.querySelector('a[href="/jobs"]');
  for (const p of [...list].reverse()) jobsTab?.after(h('a', { href: `/jobs?who=${encodeURIComponent(p.who)}`, 'data-link': true }, h('b', {}, p.name[0]), p.name));
  markTabs();
}
// "You · <name>" switch on the /jobs pages: same page, another person's agent.
async function personBar() {
  const list = await loadPeople();
  if (list.length < 2) return null;
  return h('div', { class: 'chips', style: 'margin-bottom:1rem' }, list.map((p) => h('a', {
    href: `${location.pathname}?who=${encodeURIComponent(p.who)}`, 'data-link': true, class: 'chip' + (p.who === who() ? ' on' : ''),
  }, p.who ? p.name : `${p.name} (you)`, p.online ? '' : ' · offline')));
}
async function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  roomStream?.close(); roomStream = null;
  clearInterval(jobsTimer); jobsTimer = null;
  clearInterval(pageTimer); pageTimer = null;
  // An untrusted browser sees nothing but this note (add-device and invite links still work).
  if (path !== '/device' && path !== '/setup') {
    me ??= await api('/me').catch(() => null);
    if (me?.device === false) {
      me = null; tabs.hidden = true; logoutBtn.hidden = true; devicesLink.hidden = true; statusEl.hidden = true;
      view.replaceChildren(h('h1', {}, 'Not available'), h('p', { class: 'lede' }, 'This device isn\'t set up. Open an add-device link from a trusted device.'));
      return;
    }
  }
  const inside = path !== '/login' && path !== '/setup' && path !== '/device';
  if (inside) {
    me ??= await api('/me').catch(() => null);
    if (limited() && (!path.startsWith('/jobs') || who() !== me.who)) return go(`/jobs?who=${encodeURIComponent(me.who)}`, false);   // only their own agent
  }
  tabs.hidden = !inside; logoutBtn.hidden = !inside; devicesLink.hidden = !inside || limited();
  if (!inside || limited()) statusEl.hidden = true;
  markTabs();
  if (inside) addPeopleTabs().catch(() => { peopleTabs = false; });
  document.title = path === '/' ? 'Tinker hub' : `${TITLES[path] || 'Not found'} · Tinker hub`;
  if (!view.firstChild) view.replaceChildren(h('p', { class: 'loading' }, 'Loading'));
  const page = pages[path] || (async () => [h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '/', 'data-link': true }, 'Back to the hub'))]);
  try {
    const nodes = await page();
    if (nodes) view.replaceChildren(...[nodes].flat().filter((n) => n != null && n !== false));
    if (inside && path !== '/' && statusEl.hidden && !limited()) refreshStatus();
  } catch (e) {
    if (location.pathname !== '/login') view.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && a.origin === location.origin && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (a.pathname + a.search !== location.pathname + location.search) { view.replaceChildren(); go(a.pathname + a.search, !a.closest('.tabs')); } }
});
logoutBtn.addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); me = null; people = null; go('/login'); });
window.addEventListener('popstate', () => { view.replaceChildren(); render(); });
render();
