import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, RequestError } from './menu.mjs';
import { answer } from './chat.mjs';

function authorize(req, token) {
  const digest = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(req.headers.authorization || ''), digest('Bearer ' + token))) {
    throw new RequestError(401, '權杖無效，請重新輸入。');
  }
}

async function jsonBody(req, limit) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new RequestError(415, '請使用 JSON。');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new RequestError(413, '傳送內容過大。');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  throw new RequestError(400, 'JSON 物件格式錯誤。');
}

function readWave(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new RequestError(400, '錄音資料格式錯誤。');
  const wav = Buffer.from(encoded, 'base64');
  let validFormat = false;
  let audioBytes = 0;
  if (wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' &&
      wav.length >= 44 && wav.readUInt32LE(4) === wav.length - 8) {
    for (let offset = 12; offset + 8 <= wav.length;) {
      const type = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (data + size > wav.length) throw new RequestError(400, '錄音檔不完整。');
      if (type === 'fmt ' && size >= 16) {
        validFormat = wav.readUInt16LE(data) === 1 && wav.readUInt16LE(data + 2) === 1 &&
          wav.readUInt32LE(data + 4) === 16000 && wav.readUInt16LE(data + 14) === 16;
      }
      if (type === 'data') audioBytes = size;
      offset = data + size + (size % 2);
    }
  }
  if (!validFormat || !audioBytes || audioBytes % 2 || audioBytes > 32000 * 60) {
    throw new RequestError(400, '請上傳 60 秒內的單聲道 16 kHz PCM16 WAV 錄音。');
  }
  return wav;
}

async function providerCall(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(503, '伺服器的語音或語言模型服務目前無法使用，請稍後再試。');
  }
}

export function makeServer({ directory, adminToken, deviceToken, voice }) {
  const store = openStore(directory);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const route = req.url.split('?')[0];
      if (req.method === 'GET' && route === '/health') return send(200, { status: 'ok' });
      if (['/api/menu', '/api/chat', '/api/voice'].includes(route)) {
        if (deviceToken) authorize(req, deviceToken);
        if (route === '/api/menu' && req.method === 'GET') return send(200, store.published());
        if (route !== '/api/menu' && req.method === 'POST') {
          const spoken = route === '/api/voice';
          const body = await jsonBody(req, spoken ? 3 * 1024 * 1024 : 8192);
          if (!['host', 'chef'].includes(body.role)) throw new RequestError(400, '角色無效。');
          const adapter = voice ?? await providerCall(() => import('./voice.mjs'));
          const turn = new AbortController();
          res.once('close', () => {
            if (!res.writableEnded) turn.abort();
          });
          const { signal } = turn;
          if (spoken) {
            const wave = readWave(body.audioBase64);
            body.message = await providerCall(() => adapter.transcribeAudio(wave, { signal }));
            if (!body.message?.trim()) throw new RequestError(422, '沒有辨識到說話聲，請再試一次。');
          }
          const menuItems = store.published().items;
          const groundedAnswer = answer(menuItems, body);
          const result = await providerCall(() => adapter.generateReply({
            message: body.message, role: body.role, groundedAnswer, menuItems, previousItemId: body.previousItemId, signal
          }));
          const response = { reply: result.reply, ...(result.itemId && { itemId: result.itemId }),
            ...(spoken && { transcript: body.message }) };
          try {
            const { audio, mime } = await providerCall(() => adapter.synthesizeSpeech({ text: result.reply, role: body.role, signal }));
            return send(200, { ...response, audioBase64: audio.toString('base64'), audioMime: mime });
          } catch (error) {
            if (signal.aborted) return;
            console.warn('TTS:', error.message);
            return send(200, { ...response, audioUnavailable: true });
          }
        }
      }
      if (route.startsWith('/api/admin/')) {
        if (!adminToken) throw new RequestError(503, '請在伺服器設定 ADMIN_TOKEN 以開啟菜單管理。');
        authorize(req, adminToken);
        if (route === '/api/admin/draft' && req.method === 'GET') return send(200, store.draft());
        if (route === '/api/admin/draft' && req.method === 'PUT') {
          const body = await jsonBody(req, 4 * 1024 * 1024);
          store.save(body.revision, body.items);
          return send(200, store.draft());
        }
        if (route === '/api/admin/publish' && req.method === 'POST') {
          const body = await jsonBody(req, 1024);
          store.publish(body.revision);
          return send(200, store.draft());
        }
      }
      throw new RequestError(404, '找不到這個端點。');
    } catch (error) {
      if (res.destroyed) return;
      if (!(error instanceof RequestError)) console.error(error);
      send(error instanceof RequestError ? error.status : 500,
        { error: error instanceof RequestError ? error.message : '伺服器無法處理要求。' });
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const server = makeServer({ directory: process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)),
    adminToken: process.env.ADMIN_TOKEN, deviceToken: process.env.DEVICE_TOKEN });
  server.listen(port, host, () => console.log(`菜單服務 http://${host}:${server.address().port}`));
}
