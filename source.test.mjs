import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSource } from './source.mjs';

const manifest = JSON.parse(readFileSync(new URL('./wire.json', import.meta.url), 'utf8'));

test('各批次来源的响应与原始材料一致', async (t) => {
  const server = makeSource().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/v1/';
  for (const [phase, resources] of Object.entries(manifest.releases)) {
    for (const [resource, file] of Object.entries(resources)) {
      const response = await fetch(base + phase + '/' + resource);
      assert.equal(response.headers.get('x-release'), phase, resource);
      assert.equal(response.status, file.status ?? 200, resource);
      if (file.status) continue;
      assert.ok(response.headers.get('content-type').startsWith(file.type), resource);
      const bytes = readFileSync(new URL('./wire/' + file.name, import.meta.url), 'utf8');
      if (file.type === 'application/json') {
        assert.deepEqual(await response.json(), JSON.parse(bytes), resource);
      } else {
        assert.equal(await response.text(), bytes, resource);
      }
    }
  }
  assert.equal((await fetch(base + 'opening/not-delivered')).status, 404);
});

test('业务端接收、查询同一请求及拒绝异报文重用请求号', async (t) => {
  const server = makeSource().listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/v1/';
  const send = (phase, payload) => fetch(base + phase + '/portal', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)
  });
  const action = Object.keys(manifest.actions).find((name) => name !== 'inspect');
  const payload = {action, key:'synthetic-source-check', facts:{scope:'wire-check'}};
  const first = await send('interim', payload);
  assert.equal(first.status, action === manifest.lateAction ? 503 : 201);
  const found = await send('interim', {action:'inspect', key:payload.key});
  assert.equal(found.status, 200);
  const existing = await found.json();
  const replay = await send('interim', payload);
  assert.deepEqual(await replay.json(), existing);
  assert.equal((await send('interim', {...payload, facts:{scope:'different'}})).status, 409);
  const confirmed = await send('confirmed', {action:'inspect', key:payload.key});
  assert.equal((await confirmed.json()).sourceRef, existing.sourceRef);
});
