'use strict';
// Hygiene Records front end. Plain JS, no build step. All text is set via textContent (no innerHTML).
// DOM helpers: accept nested arrays and skip null/false, so lists of elements render as elements (not text).
const flatKids = (a) => a.flat(Infinity).filter((x) => x != null && x !== false);
for (const m of ['append', 'replaceChildren']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...a) { return orig.apply(this, flatKids(a)); };
}
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), me: null, site: null, today: null, tab: 'today' };

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && S.token) { signOutLocal(); throw new Error('Please sign in again'); }
  if (raw) { if (!res.ok) throw new Error('Download failed'); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
let toastTimer;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTemp = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}°C`;
const KIND = { fridge: 'Fridge', freezer: 'Freezer', hot_hold: 'Hot holding', cold_display: 'Cold display', delivery: 'Delivery', other: 'Other' };

function modal(title, sub, build) {
  const close = () => bg.remove();
  const body = h('div');
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, h('h3', null, title), sub ? h('div', { class: 'mute' }, sub) : null, body));
  build(body, close);
  document.body.append(bg);
  return close;
}
async function guarded(btn, errEl, fn) {
  btn.disabled = true; if (errEl) errEl.textContent = '';
  try { await fn(); } catch (e) { if (errEl) errEl.textContent = e.message; else toast(e.message); } finally { btn.disabled = false; }
}
const field = (label, input) => h('div', null, h('label', null, label), input);

// ---------- auth ----------
function signOutLocal() { localStorage.removeItem('token'); S.token = null; S.me = null; renderAuth(); }
function renderAuth(mode = 'login') {
  const err = h('div', { class: 'err', role: 'alert' });
  const v = {};
  const inp = (key, type, ph, extra = {}) => (v[key] = h('input', { type, placeholder: ph, required: true, ...extra }));
  const reg = mode === 'register';
  const form = h('form', { class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    guarded(btn, err, async () => {
      const body = reg ? { business: v.business.value, name: v.name.value, email: v.email.value, password: v.password.value } : { email: v.email.value, password: v.password.value };
      const { token } = await api(`/api/auth/${reg ? 'register' : 'login'}`, { method: 'POST', body });
      S.token = token; localStorage.setItem('token', token); await boot();
    });
  } },
    reg ? field('Business name', inp('business', 'text', 'e.g. The Corner Café', { autocomplete: 'organization', maxLength: 120 })) : null,
    reg ? field('Your name', inp('name', 'text', 'Your name', { autocomplete: 'name', maxLength: 80 })) : null,
    field('Email', inp('email', 'email', 'you@example.com', { autocomplete: 'email', inputMode: 'email' })),
    field('Password', inp('password', 'password', reg ? 'At least 8 characters' : 'Password', { autocomplete: reg ? 'new-password' : 'current-password', minLength: reg ? 8 : 1 })),
    err,
    h('button', { class: 'btn block', type: 'submit' }, reg ? 'Create account' : 'Sign in'),
    h('button', { class: 'btn sec block', type: 'button', onclick: () => renderAuth(reg ? 'login' : 'register') }, reg ? 'I already have an account' : 'Set up a new business'));
  $app.replaceChildren(h('div', { class: 'auth' }, h('h1', null, 'Hygiene Records'), h('p', { class: 'mute' }, 'Temperature logs and cleaning checklists, signed and time-stamped, ready for your next inspection.'), form));
}

// ---------- shell ----------
const TABS = [['today', '🏠', 'Today'], ['temps', '🌡️', 'Temps'], ['checklists', '✅', 'Checks'], ['reports', '📄', 'Reports'], ['settings', '⚙️', 'Setup']];
async function boot() {
  try {
    const me = await api('/api/me');
    Object.assign(S, { me: me.user, site: me.site, today: me.today });
    renderShell();
  } catch { renderAuth(); }
}
function renderShell() {
  const main = h('main');
  const nav = h('nav', { class: 'tabs' }, h('div', { class: 'in' }, TABS.filter(([k]) => k !== 'settings' || S.me.role === 'owner').map(([k, ic, label]) =>
    h('button', { 'aria-current': S.tab === k ? 'page' : null, onclick: () => { S.tab = k; renderShell(); } }, h('span', { class: 'ic' }, ic), label))));
  $app.replaceChildren(
    h('header', { class: 'top' }, h('h1', null, S.site.name, h('small', null, `${S.me.name} · ${fmtDay(S.today)}`)),
      h('button', { class: 'btn sec sm', onclick: async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} signOutLocal(); } }, 'Sign out')),
    main, nav);
  const views = { today: viewToday, temps: viewTemps, checklists: viewChecklists, reports: viewReports, settings: viewSettings };
  Promise.resolve(views[S.tab](main)).catch((e) => main.replaceChildren(h('div', { class: 'err' }, e.message)));
}
const refresh = () => renderShell();

// ---------- today ----------
async function viewToday(main) {
  const d = await api('/api/dashboard');
  const tempsDone = d.equipment.filter((e) => e.today_count > 0).length;
  const listsDone = d.checklists.filter((c) => c.done).length;
  main.replaceChildren(
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('div', { class: 'mute' }, 'Temperature checks'), h('div', { class: 'big' }, `${tempsDone}/${d.equipment.length}`)),
      h('div', { class: 'card' }, h('div', { class: 'mute' }, 'Checklists done'), h('div', { class: 'big' }, `${listsDone}/${d.checklists.length}`))),
    d.alerts.length ? [h('h2', null, 'Needs attention'), ...d.alerts.map((a) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', null, a.equipment_name), h('span', { class: 'pill alert' }, fmtTemp(a.temp))),
      h('div', { class: 'mute' }, `Safe range ${fmtTemp(a.min_temp)} to ${fmtTemp(a.max_temp)} · ${fmtTime(a.logged_at)} · ${a.user_name}`),
      h('div', null, 'Action: ', a.corrective_action)))] : null,
    h('h2', null, 'Temperature checks'),
    d.equipment.length ? d.equipment.map((e) => h('button', { class: 'card tap', onclick: () => logTemp(e) },
      h('div', { class: 'row' }, h('strong', null, e.name), h('span', { class: `pill ${e.status}` }, e.status === 'due' ? 'Due' : e.status === 'ok' ? `✓ ${fmtTemp(e.last.temp)}` : `⚠ ${fmtTemp(e.last.temp)}`)),
      h('div', { class: 'mute' }, e.last ? `Last: ${fmtTime(e.last.logged_at)} by ${e.last.user_name}` : 'Not checked yet today'))) : h('div', { class: 'mute' }, 'No equipment set up yet. Add some under Setup.'),
    h('h2', null, 'Checklists'),
    d.checklists.map((c) => h('button', { class: 'card tap', onclick: () => openChecklist(c.id) },
      h('div', { class: 'row' }, h('strong', null, c.name), h('span', { class: `pill ${c.done ? 'ok' : 'due'}` }, c.done ? '✓ Done' : 'Due')),
      h('div', { class: 'mute' }, c.done ? `Signed off by ${c.last.user_name} at ${fmtTime(c.last.completed_at)}` : c.frequency === 'weekly' ? 'Weekly' : 'Daily'))));
}

// ---------- temperatures ----------
function logTemp(e) {
  modal(e.name, `Safe range ${fmtTemp(e.min_temp)} to ${fmtTemp(e.max_temp)}`, (body, close) => {
    const temp = h('input', { class: 'temp-input', type: 'number', step: '0.1', inputMode: 'decimal', placeholder: '°C', autofocus: true });
    const hint = h('div'); const action = h('textarea', { placeholder: 'e.g. Moved food to another fridge, called engineer', maxLength: 300 });
    const actionWrap = h('div', { hidden: true }, field('Corrective action taken (required)', action));
    const note = h('input', { type: 'text', placeholder: 'Optional', maxLength: 300 });
    const err = h('div', { class: 'err', role: 'alert' });
    const check = () => {
      const t = parseFloat(temp.value);
      if (Number.isNaN(t)) { hint.replaceChildren(); actionWrap.hidden = true; return; }
      const ok = t >= e.min_temp && t <= e.max_temp;
      hint.replaceChildren(h('div', { class: ok ? 'okbox' : 'alertbox' }, ok ? '✓ Within safe range' : `⚠ Outside safe range (${fmtTemp(e.min_temp)} to ${fmtTemp(e.max_temp)})`));
      actionWrap.hidden = ok;
    };
    temp.addEventListener('input', check);
    const save = h('button', { class: 'btn block', style: 'margin-top:16px', onclick: () => guarded(save, err, async () => {
      await api('/api/temps', { method: 'POST', body: { equipment_id: e.id, temp: temp.value, corrective_action: action.value, note: note.value } });
      close(); toast('Temperature logged'); refresh();
    }) }, `Save as ${S.me.name}`);
    body.append(field('Reading (°C)', temp), hint, actionWrap, field('Note', note), err, save);
    setTimeout(() => temp.focus(), 50);
  });
}
async function viewTemps(main) {
  const [eq, logs] = await Promise.all([api('/api/equipment'), api('/api/temps?limit=60')]);
  main.replaceChildren(
    h('h2', null, 'Log a reading'),
    eq.filter((e) => e.active).map((e) => h('button', { class: 'card tap', onclick: () => logTemp(e) },
      h('div', { class: 'row' }, h('strong', null, e.name), h('span', { class: 'mute' }, `${KIND[e.kind] || e.kind} · ${fmtTemp(e.min_temp)} to ${fmtTemp(e.max_temp)}`)))),
    h('h2', null, 'Recent readings'),
    logs.length ? logs.map((l) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', null, l.equipment_name), h('span', { class: `pill ${l.in_range ? 'ok' : 'alert'}` }, fmtTemp(l.temp))),
      h('div', { class: 'mute' }, `${fmtDateTime(l.logged_at)} · ${l.user_name}`),
      l.corrective_action ? h('div', null, 'Action: ', l.corrective_action) : null, l.note ? h('div', { class: 'mute' }, l.note) : null)) : h('div', { class: 'mute' }, 'No readings yet.'));
}

// ---------- checklists ----------
async function openChecklist(id) {
  const lists = await api('/api/checklists');
  const c = lists.find((x) => x.id === id);
  if (!c) return toast('Checklist not found');
  modal(c.name, 'Tick each item, or add a note if it could not be done.', (body, close) => {
    const rows = c.items.map((it) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': it.text });
      const note = h('input', { type: 'text', placeholder: 'Why not done / what was done about it?', maxLength: 300 });
      const noteWrap = h('div', { class: 'note', hidden: true }, note);
      cb.addEventListener('change', () => { noteWrap.hidden = cb.checked; });
      return { it, cb, note, el: h('div', { class: 'check' }, cb, h('div', { class: 't' }, h('div', null, it.text), noteWrap)) };
    });
    const allBtn = h('button', { class: 'btn sec sm', onclick: () => rows.forEach((r) => { r.cb.checked = true; r.cb.dispatchEvent(new Event('change')); }) }, 'Tick all');
    const comment = h('textarea', { placeholder: 'Optional comment for the record', maxLength: 500 });
    const err = h('div', { class: 'err', role: 'alert' });
    const submit = h('button', { class: 'btn block', style: 'margin-top:14px', onclick: () => guarded(submit, err, async () => {
      await api('/api/runs', { method: 'POST', body: { checklist_id: c.id, comment: comment.value, items: rows.map((r) => ({ item_id: r.it.id, checked: r.cb.checked, note: r.note.value })) } });
      close(); toast('Checklist signed off'); refresh();
    }) }, `Sign off as ${S.me.name}`);
    body.append(h('div', { class: 'row', style: 'margin-top:8px' }, h('span'), allBtn), h('div', { class: 'card' }, rows.map((r) => r.el)), field('Comment', comment), err, submit);
  });
}
async function viewChecklists(main) {
  const [lists, runs] = await Promise.all([api('/api/checklists'), api('/api/runs?' + new URLSearchParams({ from: dateAgo(30), to: S.today }))]);
  main.replaceChildren(
    h('h2', null, 'Start a checklist'),
    lists.map((c) => h('button', { class: 'card tap', onclick: () => openChecklist(c.id) },
      h('div', { class: 'row' }, h('strong', null, c.name), h('span', { class: 'mute' }, `${c.frequency === 'weekly' ? 'Weekly' : 'Daily'} · ${c.items.length} items`)))),
    h('h2', null, 'Completed (last 30 days)'),
    runs.length ? runs.map((r) => {
      const flagged = r.items.filter((i) => !i.checked);
      return h('button', { class: 'card tap', onclick: () => showRun(r) },
        h('div', { class: 'row' }, h('strong', null, r.checklist_name), h('span', { class: `pill ${flagged.length ? 'due' : 'ok'}` }, flagged.length ? `${flagged.length} flagged` : '✓ All done')),
        h('div', { class: 'mute' }, `${fmtDateTime(r.completed_at)} · ${r.user_name}`));
    }) : h('div', { class: 'mute' }, 'Nothing completed yet.'));
}
function showRun(r) {
  modal(r.checklist_name, `${fmtDateTime(r.completed_at)} · signed off by ${r.user_name}`, (body) => {
    body.append(h('div', { class: 'card', style: 'margin-top:12px' }, r.items.map((i) => h('div', { class: 'check' }, h('span', null, i.checked ? '✅' : '⚠️'), h('div', { class: 't' }, i.text, i.note ? h('div', { class: 'mute' }, i.note) : null)))),
      r.comment ? h('div', { class: 'card' }, r.comment) : null);
  });
}
const dateAgo = (n) => { const d = new Date(S.today + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

// ---------- reports ----------
async function viewReports(main) {
  const from = h('input', { type: 'date', value: dateAgo(6) }), to = h('input', { type: 'date', value: S.today });
  const out = h('div');
  const load = async () => {
    out.replaceChildren(h('div', { class: 'mute' }, 'Loading…'));
    const q = new URLSearchParams({ from: from.value, to: to.value });
    const r = await api('/api/report?' + q);
    const s = r.summary;
    out.replaceChildren(
      h('div', { class: 'printonly' }, h('h1', null, `${r.site}: hygiene records`), h('p', null, `${r.from} to ${r.to} · generated ${new Date(r.generated_at).toLocaleString()}`)),
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('div', { class: 'mute' }, 'Temperature checks'), h('div', { class: 'big' }, s.temp_checks)),
        h('div', { class: 'card' }, h('div', { class: 'mute' }, 'Out of range'), h('div', { class: 'big', style: s.out_of_range ? 'color:var(--bad)' : '' }, s.out_of_range)),
        h('div', { class: 'card' }, h('div', { class: 'mute' }, 'Checklists signed'), h('div', { class: 'big' }, s.checklists_completed)),
        h('div', { class: 'card' }, h('div', { class: 'mute' }, 'Items flagged'), h('div', { class: 'big', style: s.items_flagged ? 'color:var(--warn)' : '' }, s.items_flagged))),
      h('h2', null, 'Temperature log'),
      r.temps.length ? h('div', { class: 'card scroll' }, h('table', null,
        h('thead', null, h('tr', null, ['When', 'Equipment', 'Temp', 'By', 'Action'].map((x) => h('th', null, x)))),
        h('tbody', null, r.temps.map((t) => h('tr', { class: t.in_range ? '' : 'bad' }, h('td', null, fmtDateTime(t.logged_at)), h('td', null, t.equipment_name), h('td', null, fmtTemp(t.temp)), h('td', null, t.user_name), h('td', null, t.corrective_action || ''))))))
        : h('div', { class: 'mute' }, 'No readings in this period.'),
      h('h2', null, 'Checklists'),
      r.runs.length ? r.runs.map((run) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', null, run.checklist_name), h('span', { class: 'mute' }, `${fmtDateTime(run.completed_at)} · ${run.user_name}`)),
        run.items.filter((i) => !i.checked).map((i) => h('div', { class: 'mute' }, `⚠ ${i.text}: ${i.note}`)),
        run.items.every((i) => i.checked) ? h('div', { class: 'mute' }, `✓ All ${run.items.length} items done`) : null,
        run.comment ? h('div', { class: 'mute' }, `Comment: ${run.comment}`) : null)) : h('div', { class: 'mute' }, 'No checklists in this period.'));
  };
  const dl = (kind) => async () => {
    try {
      const res = await api(`/api/export/${kind}.csv?` + new URLSearchParams({ from: from.value, to: to.value }), { raw: true });
      const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `${kind}_${from.value}_${to.value}.csv` }); document.body.append(a); a.click(); a.remove();
    } catch (e) { toast(e.message); }
  };
  main.replaceChildren(h('div', { class: 'noprint' },
    h('h2', null, 'Period'), h('div', { class: 'grid2' }, field('From', from), field('To', to)),
    h('div', { class: 'seg' }, h('button', { class: 'btn sec sm', onclick: () => { from.value = dateAgo(6); to.value = S.today; load(); } }, '7 days'), h('button', { class: 'btn sec sm', onclick: () => { from.value = dateAgo(29); to.value = S.today; load(); } }, '30 days'), h('button', { class: 'btn sm', onclick: () => load().catch((e) => toast(e.message)) }, 'Update')),
    h('div', { class: 'seg' }, h('button', { class: 'btn sec sm', onclick: () => window.print() }, '🖨 Print / save PDF'), h('button', { class: 'btn sec sm', onclick: dl('temps') }, 'Temps CSV'), h('button', { class: 'btn sec sm', onclick: dl('checklists') }, 'Checks CSV'))), out);
  await load();
}

// ---------- settings (owner) ----------
async function viewSettings(main) {
  const [eq, lists, staff] = await Promise.all([api('/api/equipment'), api('/api/checklists?all=1'), api('/api/staff')]);
  main.replaceChildren(
    h('div', { class: 'row' }, h('h2', null, 'Equipment'), h('button', { class: 'btn sm', onclick: () => editEquipment() }, '+ Add')),
    eq.map((e) => h('button', { class: 'card tap', style: e.active ? '' : 'opacity:.5', onclick: () => editEquipment(e) },
      h('div', { class: 'row' }, h('strong', null, e.name), h('span', { class: 'mute' }, `${fmtTemp(e.min_temp)} to ${fmtTemp(e.max_temp)}${e.active ? '' : ' · off'}`)))),
    h('div', { class: 'row' }, h('h2', null, 'Checklists'), h('button', { class: 'btn sm', onclick: () => editChecklist() }, '+ Add')),
    lists.map((c) => h('button', { class: 'card tap', style: c.active ? '' : 'opacity:.5', onclick: () => editChecklist(c) },
      h('div', { class: 'row' }, h('strong', null, c.name), h('span', { class: 'mute' }, `${c.frequency} · ${c.items.length} items${c.active ? '' : ' · off'}`)))),
    h('div', { class: 'row' }, h('h2', null, 'Team'), h('button', { class: 'btn sm', onclick: addStaff }, '+ Add')),
    staff.map((u) => h('div', { class: 'card', style: u.active ? '' : 'opacity:.5' }, h('div', { class: 'row' }, h('div', null, h('strong', null, u.name), h('div', { class: 'mute' }, `${u.email} · ${u.role}`)),
      u.id !== S.me.id ? h('button', { class: 'btn sec sm', onclick: async () => { try { await api(`/api/staff/${u.id}`, { method: 'PUT', body: { active: !u.active } }); refresh(); } catch (e) { toast(e.message); } } }, u.active ? 'Deactivate' : 'Reactivate') : null))));
}
function editEquipment(e) {
  modal(e ? 'Edit equipment' : 'Add equipment', 'Readings outside the range need a corrective action.', (body, close) => {
    const name = h('input', { type: 'text', value: e?.name || '', maxLength: 80, placeholder: 'e.g. Walk-in fridge' });
    const kind = h('select', null, Object.entries(KIND).map(([k, l]) => h('option', { value: k, selected: (e?.kind || 'fridge') === k }, l)));
    const min = h('input', { type: 'number', step: '0.5', value: e ? e.min_temp : 0, inputMode: 'decimal' }), max = h('input', { type: 'number', step: '0.5', value: e ? e.max_temp : 5, inputMode: 'decimal' });
    const err = h('div', { class: 'err', role: 'alert' });
    const save = h('button', { class: 'btn block', onclick: () => guarded(save, err, async () => {
      const b = { name: name.value, kind: kind.value, min_temp: min.value, max_temp: max.value };
      await api(e ? `/api/equipment/${e.id}` : '/api/equipment', { method: e ? 'PUT' : 'POST', body: b }); close(); refresh();
    }) }, 'Save');
    const toggle = e ? h('button', { class: 'btn sec block', style: 'margin-top:8px', onclick: async () => { try { await api(`/api/equipment/${e.id}`, { method: 'PUT', body: { active: !e.active } }); close(); refresh(); } catch (x) { toast(x.message); } } }, e.active ? 'Switch off (keeps history)' : 'Switch back on') : null;
    body.append(field('Name', name), field('Type', kind), h('div', { class: 'grid2' }, field('Min °C', min), field('Max °C', max)), err, h('div', { style: 'margin-top:14px' }, save), toggle);
  });
}
function editChecklist(c) {
  modal(c ? 'Edit checklist' : 'Add checklist', 'One item per line. Past sign-offs are never changed.', (body, close) => {
    const name = h('input', { type: 'text', value: c?.name || '', maxLength: 80, placeholder: 'e.g. Opening checks' });
    const freq = h('select', null, ['daily', 'weekly'].map((f) => h('option', { value: f, selected: (c?.frequency || 'daily') === f }, f === 'daily' ? 'Daily' : 'Weekly')));
    const items = h('textarea', { style: 'min-height:200px', value: c ? c.items.map((i) => i.text).join('\n') : '' });
    const err = h('div', { class: 'err', role: 'alert' });
    const save = h('button', { class: 'btn block', onclick: () => guarded(save, err, async () => {
      const b = { name: name.value, frequency: freq.value, items: items.value.split('\n') };
      await api(c ? `/api/checklists/${c.id}` : '/api/checklists', { method: c ? 'PUT' : 'POST', body: b }); close(); refresh();
    }) }, 'Save');
    const toggle = c ? h('button', { class: 'btn sec block', style: 'margin-top:8px', onclick: async () => { try { await api(`/api/checklists/${c.id}`, { method: 'PUT', body: { name: c.name, frequency: c.frequency, items: c.items.map((i) => i.text), active: !c.active } }); close(); refresh(); } catch (x) { toast(x.message); } } }, c.active ? 'Switch off (keeps history)' : 'Switch back on') : null;
    body.append(field('Name', name), field('How often', freq), field('Items', items), err, h('div', { style: 'margin-top:14px' }, save), toggle);
  });
}
function addStaff() {
  modal('Add team member', 'They sign in with their own email and password, so every record shows who did it.', (body, close) => {
    const name = h('input', { type: 'text', maxLength: 80, placeholder: 'Name' }), email = h('input', { type: 'email', placeholder: 'Email' }), pw = h('input', { type: 'text', placeholder: 'Temporary password (8+ characters)', autocomplete: 'off' });
    const err = h('div', { class: 'err', role: 'alert' });
    const save = h('button', { class: 'btn block', onclick: () => guarded(save, err, async () => { await api('/api/staff', { method: 'POST', body: { name: name.value, email: email.value, password: pw.value } }); close(); toast('Team member added'); refresh(); }) }, 'Add');
    body.append(field('Name', name), field('Email', email), field('Password', pw), err, h('div', { style: 'margin-top:14px' }, save));
  });
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
S.token ? boot() : renderAuth();
