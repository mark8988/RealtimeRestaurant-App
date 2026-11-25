import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, validateItems } from './menu.mjs';
import { answer } from './chat.mjs';
import { makeServer } from './index.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'restaurant-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('store publishes complete snapshots, rejects stale saves and reloads the last state', t => {
  const path = directory(t);
  const store = openStore(path);
  const draft = structuredClone(store.draft());
  draft.items[0].price = 315;
  store.save(draft.revision, draft.items);
  assert.equal(store.published().items[0].price, 280);
  assert.throws(() => store.publish(draft.revision), { status: 409 });
  assert.throws(() => store.save(draft.revision, []), { status: 409 });
  const restarted = openStore(path);
  restarted.publish(restarted.draft().revision);
  assert.equal(openStore(path).published().items[0].price, 315);
  assert.equal(openStore(path).published().version, 2);
});

test('rejects invalid prices, duplicate IDs and malformed lists', t => {
  const [first] = openStore(directory(t)).published().items;
  for (const items of [[first,first], [{ ...first, price: -1 }], [{ ...first, allergens: '牛奶' }], [null]]) {
    assert.throws(() => validateItems(items), { status: 400 });
  }
});

test('asks and follows up using the published menu facts and recorded availability', t => {
  const { items } = openStore(directory(t)).published();
  const ask = (message, previousItemId, role = 'host') => answer(items, { message, previousItemId, role });
  const recommended = ask('推薦二百元以上的全素主食');
  assert.equal(recommended.itemId, 'mushroom-rice');
  assert.match(ask('多少錢', recommended.itemId).reply, /220 元/);
  assert.match(ask('那道有什麼過敏原', recommended.itemId).reply, /大豆.*交叉接觸/);
  assert.match(ask('我對芝麻過敏').reply, /花椒芝麻拌麵/);
  assert.equal(ask('推薦主食，預算200元').itemId, 'sesame-noodles');
  assert.equal(ask('想吃全素主食，預算100元').itemId, undefined);
  assert.equal(ask('想吃兩百元以下的主食').itemId, 'sesame-noodles');
  assert.equal(ask('想吃三百元以上的主食').itemId, undefined);
  const mildRequest = ask('我不要太辣，有推薦嗎？');
  assert.ok(mildRequest.semanticCandidates.length);
  assert.ok(mildRequest.semanticCandidates.every(id => items.find(item => item.id === id).tags.includes('不辣')));
  const inexpensive = ask('我不想花超過兩百塊，有推薦嗎？');
  assert.equal(inexpensive.itemId, 'sesame-noodles');
  assert.ok(inexpensive.semanticCandidates.every(id => items.find(item => item.id === id).price <= 200));
  assert.match(ask('介紹野菇炊飯', null, 'chef').reply, /主廚.*香菇/);
  assert.notEqual(ask('換一道', recommended.itemId).itemId, recommended.itemId);
});

function recording() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24);
  b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34);
  b.write('data',36); b.writeUInt32LE(4,40);
  return b;
}

async function running(t) {
  const calls = [];
  const voice = {
    async transcribeAudio(b) { calls.push('stt'); assert.deepEqual(b, recording()); return '野菇炊飯多少錢'; },
    async generateReply({ groundedAnswer, menuItems }) { calls.push('llm'); assert.ok(menuItems.length); return { reply: groundedAnswer.reply, itemId: groundedAnswer.itemId }; },
    async synthesizeSpeech() { calls.push('tts'); return { audio: Buffer.from([1,2]), mime: 'audio/mpeg' }; }
  };
  const server = makeServer({ directory: directory(t), adminToken: 'staff', deviceToken: 'device', voice });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, token, method, body, signal) => fetch('http://127.0.0.1:' + server.address().port + route, {
    method, signal, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body) });
  return { request, calls, voice };
}

test('access controls separate staff draft and publication from tablet reads', async t => {
  const { request } = await running(t);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/menu')).status, 401);
  assert.equal((await request('/api/admin/draft', 'device')).status, 401);
  const draft = await (await request('/api/admin/draft', 'staff')).json();
  draft.items[0].price = 340;
  const saved = await (await request('/api/admin/draft','staff','PUT',draft)).json();
  const read = async () => (await request('/api/menu','device')).json();
  assert.equal((await read()).items[0].price, 280);
  assert.equal((await request('/api/admin/publish','staff','POST',{ revision: saved.revision })).status, 200);
  assert.equal((await read()).items[0].price, 340);
  assert.equal((await read()).version, 2);
});

test('voice and typed chat use the server model and speech pipeline, with explicit provider failure', async t => {
  const { request, calls, voice } = await running(t);
  const post = (path, data) => request('/api/' + path, 'device', 'POST', { role: 'host', ...data });
  const voiceResult = await (await post('voice', { audioBase64: recording().toString('base64') })).json();
  assert.deepEqual(calls.splice(0), ['stt', 'llm', 'tts']);
  assert.equal(voiceResult.transcript, '野菇炊飯多少錢');
  assert.equal(voiceResult.itemId, 'mushroom-rice');
  assert.equal(voiceResult.audioBase64, 'AQI=');
  const typed = await (await post('chat', { message: '多少錢', previousItemId: voiceResult.itemId })).json();
  assert.deepEqual(calls.splice(0), ['llm', 'tts']);
  assert.match(typed.reply, /220 元/);
  assert.equal((await post('voice', { audioBase64: 'aaaa' })).status, 400);
  assert.deepEqual(calls, []);
  voice.synthesizeSpeech = async () => { throw new Error('offline TTS'); };
  const fallback = await (await post('chat', { message: '野菇炊飯多少錢' })).json();
  assert.match(fallback.reply, /220 元/);
  assert.equal(fallback.audioUnavailable, true);
  assert.equal(fallback.audioBase64, undefined);
  voice.generateReply = async () => { throw new Error('offline'); };
  assert.equal((await post('chat', { message: '推薦' })).status, 503);
});

test('ending a guest session aborts the in-flight provider and skips speech synthesis', { timeout: 5000 }, async t => {
  const { request, calls, voice } = await running(t);
  const active = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  voice.generateReply = async ({ signal }) => {
    active.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    cancelled.resolve();
    throw new Error('turn cancelled');
  };

  const turn = new AbortController();
  const submission = assert.rejects(request('/api/chat', 'device', 'POST',
    { role: 'host', message: '推薦一道菜' }, turn.signal), { name: 'AbortError' });
  await active.promise;
  turn.abort();
  await submission;
  await cancelled.promise;
  assert.deepEqual(calls, []);
});
