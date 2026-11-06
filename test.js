'use strict';
// End-to-end API test. Uses a throwaway database.
process.env.DB_FILE = require('node:path').join(require('node:os').tmpdir(), `hygiene-test-${process.pid}.db`);
const assert = require('node:assert/strict');
const { server } = require('./server.js');

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  const call = async (method, path, body, tok = token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
  const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  const step = (n) => console.log('✓', n);

  // static + auth gate
  assert.equal((await call('GET', '/')).status, 200); step('serves app shell');
  assert.equal((await call('GET', '/server.js')).status === 200, false); step('blocks path traversal');
  assert.equal((await call('GET', '/api/me')).status, 401); step('API requires sign-in');

  // register
  assert.equal((await call('POST', '/api/auth/register', { business: 'Test Café', name: 'Sam', email: 'sam@test.com', password: 'short' })).status, 400);
  token = ok(await call('POST', '/api/auth/register', { business: 'Test Café', name: 'Sam', email: 'sam@test.com', password: 'correct horse' })).token;
  assert.equal((await call('POST', '/api/auth/register', { business: 'X', name: 'Y', email: 'SAM@test.com', password: 'correct horse' })).status, 409);
  const me = ok(await call('GET', '/api/me'));
  assert.equal(me.user.role, 'owner'); assert.equal(me.site.name, 'Test Café'); step('register + me');

  assert.equal((await call('POST', '/api/auth/login', { email: 'sam@test.com', password: 'wrong' })).status, 401);
  ok(await call('POST', '/api/auth/login', { email: 'sam@test.com', password: 'correct horse' })); step('login');

  // seeded data
  const eq = ok(await call('GET', '/api/equipment'));
  assert.equal(eq.length, 4);
  const fridge = eq.find((e) => e.name === 'Walk-in fridge');
  const lists = ok(await call('GET', '/api/checklists'));
  assert.equal(lists.length, 3); step('starter equipment + checklists seeded');

  // temperature logging
  assert.equal((await call('POST', '/api/temps', { equipment_id: fridge.id, temp: 'abc' })).status, 400);
  const good = ok(await call('POST', '/api/temps', { equipment_id: fridge.id, temp: 3.5 }));
  assert.equal(good.in_range, true);
  assert.equal((await call('POST', '/api/temps', { equipment_id: fridge.id, temp: 9 })).status, 400); // needs corrective action
  const badLog = ok(await call('POST', '/api/temps', { equipment_id: fridge.id, temp: 9, corrective_action: 'Moved stock, called engineer' }));
  assert.equal(badLog.in_range, false); step('temp logging + corrective action enforced');

  // dashboard
  let dash = ok(await call('GET', '/api/dashboard'));
  assert.equal(dash.alerts.length, 1);
  assert.equal(dash.equipment.find((e) => e.id === fridge.id).status, 'alert');
  assert.equal(dash.equipment.filter((e) => e.status === 'due').length, 3); step('dashboard status');

  // checklist run
  const open = lists.find((l) => l.name === 'Opening checks');
  const items = open.items.map((i, n) => ({ item_id: i.id, checked: n !== 1, note: n === 1 ? 'Out of soap, ordered more' : '' }));
  assert.equal((await call('POST', '/api/runs', { checklist_id: open.id, items: open.items.map((i) => ({ item_id: i.id, checked: false })) })).status, 400); // unchecked w/o note
  ok(await call('POST', '/api/runs', { checklist_id: open.id, items, comment: 'Busy morning' }));
  dash = ok(await call('GET', '/api/dashboard'));
  assert.equal(dash.checklists.find((c) => c.id === open.id).done, true); step('checklist sign-off');

  // report + csv
  const rep = ok(await call('GET', '/api/report'));
  assert.deepEqual(rep.summary, { temp_checks: 2, out_of_range: 1, checklists_completed: 1, items_flagged: 1 }); step('report summary');
  const csv = await call('GET', '/api/export/temps.csv');
  assert.equal(csv.status, 200); assert.match(csv.data, /Walk-in fridge/); assert.match(csv.data, /NO/); step('CSV export');
  assert.equal((await call('GET', '/api/report?from=bad')).status, 400); step('date validation');

  // staff + roles + tenant isolation
  const staff = ok(await call('POST', '/api/staff', { name: 'Alex', email: 'alex@test.com', password: 'staffpass1' }));
  const staffTok = ok(await call('POST', '/api/auth/login', { email: 'alex@test.com', password: 'staffpass1' })).token;
  assert.equal((await call('POST', '/api/equipment', { name: 'x', kind: 'fridge', min_temp: 0, max_temp: 5 }, staffTok)).status, 403);
  assert.equal((await call('GET', '/api/staff', null, staffTok)).status, 403);
  ok(await call('POST', '/api/temps', { equipment_id: fridge.id, temp: 4 }, staffTok));
  const logs = ok(await call('GET', '/api/temps', null, staffTok));
  assert.equal(logs[0].user_name, 'Alex'); step('staff role limits + attribution');
  ok(await call('PUT', `/api/staff/${staff.id}`, { active: false }));
  assert.equal((await call('GET', '/api/me', null, staffTok)).status, 401); step('deactivated staff locked out');

  const other = ok(await call('POST', '/api/auth/register', { business: 'Other', name: 'Zed', email: 'zed@other.com', password: 'password123' })).token;
  assert.equal(ok(await call('GET', '/api/temps', null, other)).length, 0);
  assert.equal((await call('POST', '/api/temps', { equipment_id: fridge.id, temp: 4 }, other)).status, 400); step('sites are isolated');

  // edit equipment / checklist
  ok(await call('PUT', `/api/equipment/${fridge.id}`, { max_temp: 8 }));
  ok(await call('PUT', `/api/checklists/${open.id}`, { name: 'Opening checks', frequency: 'daily', items: ['One', 'Two'] }));
  assert.equal(ok(await call('GET', '/api/runs')).length, 1, 'old runs keep their history'); step('edits keep history');

  console.log('\nAll tests passed');
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
