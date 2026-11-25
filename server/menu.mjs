import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(message) {
  throw new RequestError(400, message);
}

function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(`${label}必填，最多 ${max} 字。`);
  }
  return value.trim();
}

function list(value, label) {
  if (!Array.isArray(value) || value.length > 30) fail(`${label}最多 30 項。`);
  return [...new Set(value.map(entry => field(entry, label, 40)))];
}

export function validateItems(items) {
  if (!Array.isArray(items) || items.length > 500) fail('菜單最多可包含 500 道餐點。');
  const ids = new Set();
  return items.map(item => {
    if (!item || typeof item !== 'object') fail('餐點格式錯誤。');
    const id = field(item.id, '餐點代碼', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail('餐點代碼必須唯一，限英數、底線與連字號。');
    ids.add(id);
    if (!Number.isSafeInteger(item.price) || item.price < 0 || item.price > 999999) fail('價格須為 0 至 999999 的整數。');
    if (typeof item.available !== 'boolean') fail('請設定供應狀態。');
    return { id, name: field(item.name, '菜名', 80), category: field(item.category, '分類', 40),
      description: field(item.description, '介紹', 600), price: item.price, available: item.available,
      tags: list(item.tags, '特色標籤'), allergens: list(item.allergens, '已知過敏原') };
  });
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'menu.json');
  let state;
  function commit(next) {
    const temp = join(directory, `menu-${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(next), { flag: 'wx', flush: true });
    renameSync(temp, file);
    state = next;
  }
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
    validateItems(state.draft);
    validateItems(state.published.items);
    if (![state.revision, state.published.version].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('菜單版本錯誤');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const items = validateItems(JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8')));
    commit({ revision: 1, draft: items, published: { version: 1, items } });
  }
  function check(revision) {
    if (revision !== state.revision) throw new RequestError(409, '其他店員已更新草稿，請重新載入後核對。');
  }
  return {
    published: () => state.published,
    draft: () => ({ revision: state.revision, version: state.published.version, items: state.draft }),
    save(revision, items) {
      check(revision);
      commit({ ...state, revision: revision + 1, draft: validateItems(items) });
    },
    publish(revision) {
      check(revision);
      commit({ ...state, revision: revision + 1, published: { version: state.published.version + 1, items: state.draft } });
    }
  };
}
