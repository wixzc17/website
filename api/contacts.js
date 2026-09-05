// Static 好友/联系人接口 —— 独立通讯录机制
//
// 数据模型（Cloudflare KV）：
//   contacts:<id>  →  [friendId, ...]         我的好友（双向已确认）
//   incoming:<id>  →  [ {from, ts}, ... ]     我收到的待处理好友请求
//   outgoing:<id>  →  [targetId, ...]         我发出的待处理好友请求
//
// 接口：
//   GET    /api/contacts?token=xxx
//            → { ok, contacts: [id...], incoming: [{from,ts}...], outgoing: [id...] }
//   POST   /api/contacts { token, targetId }
//            发起好友请求；若对方已请求过我 → 直接互加成为好友
//   POST   /api/contacts { token, targetId, action: 'accept' | 'reject' }
//            处理收到的好友请求
//   DELETE /api/contacts?token=xxx&targetId=yyy
//            删除好友（双向移除）
//
// 服务器只存「关系」，不碰任何消息/密钥内容。会话密钥仍由 keys.js 负责。

import crypto from 'crypto';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
const KV_AUTH = { 'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}` };
const KV_HEADERS = {
    'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
    'Content-Type': 'application/json'
};

export default async function handler(request, response) {
    // 读取用户密码哈希：STATIC_USERS 优先，KV 注册账号兜底
    async function findUserHash(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].hash) return users[id].hash;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), { headers: KV_AUTH });
            if (res.ok) {
                const acct = await res.json();
                if (acct && typeof acct.hash === 'string') return acct.hash;
            }
        } catch (e) {}
        return null;
    }

    // 验证会话 token（与 users.js / keys.js 相同签名逻辑），返回 { id } 或 null
    async function parseToken(token) {
        if (!token || typeof token !== 'string' || token.length > 512) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [id, ts, sig] = parts;
        if (!/^[a-zA-Z0-9]+$/.test(id) || !/^\d+$/.test(ts) || !/^[a-f0-9]{16}$/.test(sig)) return null;
        const age = Date.now() - parseInt(ts, 10);
        if (age < 0 || age > 7 * 24 * 3600 * 1000) return null;

        const userHash = await findUserHash(id);
        if (!userHash) return null;

        const material = id + '.' + ts + '.' + userHash + '.static-salt';
        const expected = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
        if (sig !== expected) return null;
        return { id };
    }

    // 读 KV 里的列表；key 不存在返回 []，存储故障抛错（由上层 500 兜底）
    async function readList(key) {
        const res = await fetch(KV_URL + encodeURIComponent(key), { headers: KV_AUTH });
        if (res.status === 404) return [];
        if (!res.ok) throw new Error('KV read failed: ' + res.status);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    }

    async function writeList(key, list) {
        const res = await fetch(KV_URL + encodeURIComponent(key), {
            method: 'PUT', headers: KV_HEADERS, body: JSON.stringify(list)
        });
        if (!res.ok) throw new Error('KV write failed: ' + res.status);
    }

    // 校验目标 ID 合法且不是自己；返回标准化后的 id 或 null
    function validTarget(raw, selfId) {
        const id = (raw || '').toString().trim().replace(/^@/, '');
        if (!/^[a-zA-Z0-9]+$/.test(id)) return null;
        if (id === selfId) return null;
        return id;
    }

    try {
        // ================= GET：我的通讯录全景 =================
        if (request.method === 'GET') {
            const url = new URL(request.url, 'https://x.local');
            const session = await parseToken(url.searchParams.get('token') || '');
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }
            const [contacts, incoming, outgoing] = await Promise.all([
                readList('contacts:' + session.id),
                readList('incoming:' + session.id),
                readList('outgoing:' + session.id)
            ]);
            return response.status(200).json({ ok: true, contacts, incoming, outgoing });
        }

        // ================= DELETE：删除好友 =================
        if (request.method === 'DELETE') {
            const url = new URL(request.url, 'https://x.local');
            const session = await parseToken(url.searchParams.get('token') || '');
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }
            const targetId = validTarget(url.searchParams.get('targetId') || '', session.id);
            if (!targetId) {
                return response.status(400).json({ ok: false, message: '参数不合法' });
            }
            // 双向移除（对方不存在也没关系，仍清理自己这一侧）
            const [mine, theirs] = await Promise.all([
                readList('contacts:' + session.id),
                readList('contacts:' + targetId)
            ]);
            await writeList('contacts:' + session.id, mine.filter(x => x !== targetId));
            await writeList('contacts:' + targetId, theirs.filter(x => x !== session.id));
            return response.status(200).json({ ok: true });
        }

        // ================= POST =================
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const session = await parseToken(body && body.token);
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }

        const targetId = validTarget(body && body.targetId, session.id);
        if (!targetId) {
            return response.status(400).json({ ok: false, message: '参数不合法' });
        }

        // ---- 处理收到的请求：accept / reject ----
        const action = (body && body.action || '').toString().trim().toLowerCase();
        if (action === 'accept' || action === 'reject') {
            const incoming = await readList('incoming:' + session.id);
            const idx = incoming.findIndex(x => x && x.from === targetId);
            if (idx === -1) {
                return response.status(404).json({ ok: false, message: '没有来自该用户的请求' });
            }
            incoming.splice(idx, 1);
            await writeList('incoming:' + session.id, incoming);

            // 清理对方「发出请求」记录（无论同意还是拒绝）
            try {
                const theirOutgoing = await readList('outgoing:' + targetId);
                await writeList('outgoing:' + targetId, theirOutgoing.filter(x => x !== session.id));
            } catch (e) { /* 对方记录缺失可忽略 */ }

            // 同意：双向加入好友
            if (action === 'accept') {
                const [mine, theirs] = await Promise.all([
                    readList('contacts:' + session.id),
                    readList('contacts:' + targetId)
                ]);
                if (!mine.includes(targetId)) mine.push(targetId);
                if (!theirs.includes(session.id)) theirs.push(session.id);
                await Promise.all([
                    writeList('contacts:' + session.id, mine),
                    writeList('contacts:' + targetId, theirs)
                ]);
            }
            return response.status(200).json({ ok: true });
        }

        // ---- 发起好友请求 ----
        // 目标必须真实存在
        if (!(await findUserHash(targetId))) {
            return response.status(404).json({ ok: false, message: '用户不存在' });
        }

        const mine = await readList('contacts:' + session.id);
        if (mine.includes(targetId)) {
            return response.status(200).json({ ok: true, already: true });
        }

        const myOutgoing = await readList('outgoing:' + session.id);
        if (myOutgoing.includes(targetId)) {
            return response.status(200).json({ ok: true, pending: true });
        }

        // 对方已经请求过我（我的 incoming 里有对方）→ 双方都有意愿，直接互加成为好友
        const myIncoming = await readList('incoming:' + session.id);
        if (myIncoming.some(x => x && x.from === targetId)) {
            const [theirContacts, theirOutgoing] = await Promise.all([
                readList('contacts:' + targetId),
                readList('outgoing:' + targetId)
            ]);
            if (!theirContacts.includes(session.id)) theirContacts.push(session.id);
            const myNew = mine.concat([targetId]);
            // 消费掉对方发来的那条请求 + 清理对方 outgoing 里对我的记录
            await writeList('incoming:' + session.id, myIncoming.filter(x => !(x && x.from === targetId)));
            await writeList('outgoing:' + targetId, theirOutgoing.filter(x => x !== session.id));
            await Promise.all([
                writeList('contacts:' + session.id, myNew),
                writeList('contacts:' + targetId, theirContacts)
            ]);
            return response.status(200).json({ ok: true, matched: true });
        }

        // 常规路径：写入我的 outgoing + 对方的 incoming
        const theirIncoming = await readList('incoming:' + targetId);
        myOutgoing.push(targetId);
        const newIncoming = theirIncoming.concat([{ from: session.id, ts: Date.now() }]);
        await Promise.all([
            writeList('outgoing:' + session.id, myOutgoing),
            writeList('incoming:' + targetId, newIncoming)
        ]);
        return response.status(200).json({ ok: true });
    } catch (e) {
        console.error('contacts handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
