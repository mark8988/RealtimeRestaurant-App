import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { makeServer } from '../../server/index.mjs';

test('staff sign in, edit a draft, reject stale edits, publish, remove and sign out', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'restaurant-mvc-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const token = randomUUID(), password = randomUUID();
    const api = makeServer({ directory, adminToken: token });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => api.close(resolve)));
    const apiUrl = 'http://127.0.0.1:' + api.address().port;

    const reserved = createServer();
    await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
    const site = 'http://127.0.0.1:' + reserved.address().port;
    await new Promise(resolve => reserved.close(resolve));
    const project = fileURLToPath(new URL('../', import.meta.url));
    const proc = spawn('dotnet', [resolve(project, 'bin/Debug/net10.0/Restaurant.Admin.dll')], {
        cwd: project, windowsHide: true, stdio: ['ignore','pipe','pipe'],
        env: { ...process.env, ASPNETCORE_URLS: site, MENU_API_URL: apiUrl, ADMIN_TOKEN: token,
            ADMIN_USERNAME: 'test-user', ADMIN_PASSWORD: password }
    });
    let logs = '';
    proc.stdout.on('data', data => { logs += data; });
    proc.stderr.on('data', data => { logs += data; });
    const exited = new Promise(resolve => proc.once('exit', resolve));
    t.after(async () => { proc.kill(); await exited; });
    for (let i = 0; i < 100; i++) {
        if (proc.exitCode != null) assert.fail('MVC failed to start: ' + logs);
        try { await fetch(site + '/Backend/Login'); break; }
        catch { await delay(100); }
    }
    const cookies = new Map();
    async function request(path, body, headers = {}) {
        const result = await fetch(site + path, { method: body ? 'POST' : 'GET', redirect: 'manual',
            headers: { Cookie: [...cookies].map(([k,v]) => k + '=' + v).join('; '), ...headers },
            body: body && new URLSearchParams(body) });
        for (const cookie of result.headers.getSetCookie()) {
            const pair = cookie.split(';')[0], equal = pair.indexOf('=');
            cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
        }
        return result;
    }
    const html = async path => {
        const response = await request(path);
        assert.equal(response.status, 200);
        return response.text();
    };
    const hidden = (page, name) => {
        const input = page.match(new RegExp('<input[^>]* name="' + name + '"[^>]*>','i'));
        assert.ok(input, 'missing ' + name);
        return input[0].match(/ value="([^"]*)"/i)[1];
    };
    const post = (path, page, fields) => request(path, {
        __RequestVerificationToken: hidden(page, '__RequestVerificationToken'), ...fields });
    const published = async () => (await fetch(apiUrl + '/api/menu')).json();
    assert.equal((await request('/Menu/Index')).status, 302);
    const login = await html('/Backend/Login');
    assert.equal((await request('/Backend/Login', { username: 'test-user', password })).status, 400);
    assert.equal((await post('/Backend/Login', login, { username: 'test-user', password })).status, 302);
    const create = await html('/Menu/CreatePage');
    const form = { Name: '驗收餐點', Category: '測試', Price: '235', Description: '測試介紹', Available: 'true',
        Tags: '全素、不辣', Allergens: '大豆', Revision: hidden(create, 'Revision') };
    assert.equal((await post('/Menu/Save', create, form)).status, 302);
    assert.equal((await post('/Menu/Save', create, form)).status, 409);
    let page = await html('/');
    const itemId = [...page.matchAll(/href="\/Menu\/UpdatePage\/([a-zA-Z0-9_-]+)"/g)].at(-1)[1];
    const edit = await html('/Menu/UpdatePage/' + itemId);
    assert.equal((await post('/Menu/Save', edit, { ...form, Id: itemId, Price: '245', Revision: hidden(edit, 'Revision') })).status, 302);
    page = await html('/');
    assert.equal((await post('/Menu/Toggle', page, { id: itemId, revision: hidden(page, 'revision') })).status, 302);
    assert.equal((await published()).items.some(i => i.id === itemId), false);
    page = await html('/');
    assert.equal((await post('/Menu/Publish', page, { revision: hidden(page, 'revision') })).status, 302);
    const menu = await published();
    const dish = menu.items.find(i => i.id === itemId);
    assert.equal(menu.version, 2);
    assert.equal(dish.price, 245);
    assert.equal(dish.available, false);
    assert.deepEqual(dish.tags, ['全素','不辣']);
    assert.deepEqual(dish.allergens, ['大豆']);
    page = await html('/');
    assert.equal((await post('/Menu/Delete', page, { id: itemId, revision: hidden(page, 'revision') })).status, 302);
    page = await html('/');
    assert.equal((await post('/Menu/Publish', page, { revision: hidden(page, 'revision') })).status, 302);
    assert.equal((await published()).items.some(i => i.id === itemId), false);
    assert.equal((await post('/Backend/Logout', page, {})).status, 302);
    assert.equal((await request('/Menu/Index')).status, 302);
});
