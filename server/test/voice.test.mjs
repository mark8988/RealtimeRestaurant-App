import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { generateReply, synthesizeSpeech, transcribeAudio } from '../voice.mjs';

function setEnvironment(t, fields) {
  for (const [name, value] of Object.entries(fields)) {
    const previous = process.env[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous == null) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

async function mockServer(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(request);
    respond(request, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { base: 'http://127.0.0.1:' + server.address().port, requests };
}

const question = { message: '這道多少錢？', role: 'chef', groundedAnswer: { reply: '玉米湯 60 元。' } };

test('STT sends the full WAV and returns trimmed Traditional Chinese or silence', async t => {
  const texts = ['  玉米湯  ', ' '];
  const { base, requests } = await mockServer(t, (_, res) => res.end(JSON.stringify({ text: texts.shift() })));
  setEnvironment(t, { VOICE_SERVICE_URL: base });
  const wave = Buffer.from('example WAV bytes');
  assert.equal(await transcribeAudio(wave), '玉米湯');
  assert.equal(await transcribeAudio(wave), '');
  assert.equal(requests[0].url, '/transcribe');
  assert.equal(requests[0].headers['content-type'], 'audio/wav');
  assert.deepEqual(requests[0].body, wave);
});

test('llama-server cannot modify a fixed price answer or add unsupported menu facts', async t => {
  const contents = ['<think></think>{"intent":"recommend","itemIds":["other"],"opening":"polite"}', '玉米湯免費', 'constructor'];
  const { base, requests } = await mockServer(t, (_, res) => {
    res.end(JSON.stringify({ choices: [{ message: { content: contents.shift() } }] }));
  });
  setEnvironment(t, { LLM_BASE_URL: base, LLM_MODEL: 'restaurant', LLM_API_KEY: 'mock-key' });
  assert.deepEqual(await generateReply(question), { reply: '我來為您說明。玉米湯 60 元。' });
  process.env.LLM_BASE_URL = base + '/v1/';
  assert.deepEqual(await generateReply(question), question.groundedAnswer);
  assert.deepEqual(await generateReply(question), question.groundedAnswer);
  assert.ok(requests.every(req => req.url === '/v1/chat/completions'));
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.chat_template_kwargs.enable_thinking, false);
  assert.equal(payload.model, 'restaurant');
  assert.equal(requests[0].headers.authorization, 'Bearer mock-key');
  assert.match(payload.messages[0].content, /主廚/);
  assert.equal(payload.response_format.json_schema.schema.properties.itemIds.maxItems, 3);
  assert.deepEqual(JSON.parse(payload.messages[1].content), { question: question.message, answer: question.groundedAnswer.reply, candidates: [] });
});

test('semantic intent selects a published dish, enforces filters and supplies its follow-up ID', async t => {
  const soup = { id: 'soup', name: '玉米濃湯', price: 65, available: true, description: '慢火熬煮玉米。', allergens: ['奶'] };
  const tea = { id: 'tea', name: '冷泡茶', price: 45, available: true, description: '冷泡烏龍，帶有花香。', allergens: [] };
  const menuItems = [soup, tea, { ...tea, id: 'off', available: false }, { ...tea, id: 'over-budget', price: 900 }];
  const plans = [
    { intent: 'recommend', itemIds: ['tea'], opening: 'direct' },
    { intent: 'describe', itemIds: ['soup'], opening: 'polite' },
    { intent: 'recommend', itemIds: ['over-budget'], opening: 'direct' },
    { intent: 'recommend', itemIds: ['off'], opening: 'direct' },
    { intent: 'recommend', itemIds: ['tea', 'invented'], opening: 'direct' },
    { intent: 'allergens', itemIds: ['tea'], opening: 'direct' },
    { intent: 'allergens', itemIds: ['soup'], opening: 'direct' },
  ];
  const { base, requests } = await mockServer(t, (_, res) => {
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plans.shift()) } }] }));
  });
  setEnvironment(t, { LLM_BASE_URL: base });
  const groundedAnswer = { reply: '請告訴我喜歡的口味。', semanticCandidates: ['soup', 'tea', 'off'] };
  const ask = message => generateReply({ message, role: 'host', groundedAnswer, menuItems, previousItemId: 'soup' });
  assert.deepEqual(await ask('我剛運動完，想來點帶花香的解解渴'), { reply: '您可以試試冷泡茶（45 元）。冷泡烏龍，帶有花香。', itemId: 'tea' });
  const sent = JSON.parse(JSON.parse(requests[0].body).messages[1].content);
  assert.deepEqual(new Set(sent.candidates.map(item => item.id)), new Set(['soup', 'tea']));
  assert.equal(sent.candidates.find(item => item.id === 'tea').description, tea.description);
  assert.equal(sent.previousItemId, 'soup');
  assert.deepEqual(await ask('那道用小火煮的特色是什麼？'), { reply: '好的。玉米濃湯（65 元）。慢火熬煮玉米。', itemId: 'soup' });
  for (let i = 0; i < 3; i++) assert.deepEqual(await ask('想找平價飲料'), { reply: groundedAnswer.reply });
  assert.match((await ask('有食物禁忌，可以喝茶嗎？')).reply, /冷泡茶目前沒有登錄過敏原。.*確認原料與交叉接觸/);
  assert.match((await ask('乳製品令我不適')).reply, /玉米濃湯已登錄的過敏原有奶。.*確認原料與交叉接觸/);
});

test('TTS requests the selected role and returns WAV audio bytes', async t => {
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0);
  wav.write('WAVE', 8);
  const { base, requests } = await mockServer(t, (_, res) => res.end(wav));
  setEnvironment(t, { VOICE_SERVICE_URL: base });
  const spoken = { text: '玉米湯 60 元。', role: 'host' };
  assert.deepEqual(await synthesizeSpeech(spoken), { audio: wav, mime: 'audio/wav' });
  assert.equal(requests[0].url, '/synthesize');
  assert.deepEqual(JSON.parse(requests[0].body), spoken);
});

test('missing LLM, timeout, malformed payload and upstream errors retain actionable status', async t => {
  setEnvironment(t, { LLM_BASE_URL: null });
  await assert.rejects(generateReply(question), { status: 503, message: /LLM_BASE_URL/ });
  const { base } = await mockServer(t, (req, res) => {
    if (req.url === '/transcribe') res.end('{}');
    if (req.url === '/synthesize') {
      res.writeHead(401);
      res.end('provider credentials are private');
    }
  });
  setEnvironment(t, { LLM_BASE_URL: base, VOICE_SERVICE_URL: base, VOICE_TIMEOUT_MS: '100' });
  await assert.rejects(transcribeAudio(Buffer.alloc(1)), { status: 502 });
  await assert.rejects(synthesizeSpeech({ text: '湯', role: 'host' }), { status: 502, message: /HTTP 401/ });
  await assert.rejects(generateReply(question), { status: 504 });
  await assert.rejects(generateReply({ ...question, signal: AbortSignal.abort() }), { status: 499 });
});

test('large menu prompts are bounded and retain relevant published items', async t => {
  const menuItems = Array.from({ length: 500 }, (_, index) => ({
    id: 'dish-' + index, name: '菜色 ' + index, category: '主食', price: 50,
    available: true, description: '當日配菜'.repeat(100), tags: [], allergens: [],
  }));
  menuItems.at(-1).name = '店家招牌紅燒豆腐';
  const { base, requests } = await mockServer(t, (_, res) => {
    res.end(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ intent: 'recommend', itemIds: ['dish-499'], opening: 'direct' }),
    } }] }));
  });
  setEnvironment(t, { LLM_BASE_URL: base });
  const response = await generateReply({ message: '有紅燒豆腐嗎？', role: 'host', menuItems,
    groundedAnswer: { reply: '請挑選菜色。', semanticCandidates: menuItems.map(item => item.id) } });
  assert.equal(response.itemId, 'dish-499');
  const { candidates } = JSON.parse(JSON.parse(requests[0].body).messages[1].content);
  assert.ok(JSON.stringify(candidates).length <= 6001);
  assert.equal(candidates[0].id, 'dish-499');
});
