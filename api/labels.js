// Static 标记接口 —— 类 X 的 affiliate label（组织归属标记）
//
// 数据模型（Cloudflare KV）：
//   label:<targetId>       →  { grantedBy, ts }         某账号被谁授予了标记
//   labels-by:<grantedBy>  →  [targetId, ...]           反向索引：某企业授予过哪些账号
//   labels:all             →  [{ targetId, grantedBy, ts }, ...]  全局索引（站长管理用）
//
// 规则：
//   - 只有企业认证账号（verified:<id>.type === 'business'）能授予标记
//   - 站长（wixzc17 / lixs17）可强制撤销任何标记
//   - 每账号最多 1 个标记；已有标记的账号不能被再次授予（需先撤销）
//   - 目标不能是企业认证账号（避免双标记视觉冲突）
//
// 接口：
//   GET  /api/labels?ids=a,b,c
//        公开批量查，返回 { ok, labels: { a: { grantedBy, ts, grantedByAvatar }, ... } }
//   GET  /api/labels?by=<企业ID>&token=<企业自己的token>
//        企业查自己授予过的所有标记，返回 { ok, grantedBy, targets: [targetId, ...] }
//        站长调用时 by 可以是任何企业 ID
//   GET  /api/labels?all=1&token=<站长token>
//        仅站长：返回全局标记列表 { ok, labels: [{ targetId, grantedBy, ts }, ...] }
//   POST /api/labels { token, targetId, action: 'grant' | 'revoke' }
//        grant：企业认证账号给目标授予标记
//        revoke：企业撤销自己授予的；站长可强制撤销任何

import crypto from 'crypto';

const ADMINS = ['wixzc17', 'lixs17'];

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

    // 验证会话 token，返回 { id } 或 null
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

    // 读认证记录：返回 { ts, type } 或 null
    async function readVerified(id) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent('verified:' + id), { headers: KV_AUTH });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || typeof data.ts !== 'number') return null;
            return { ts: data.ts, type: data.type === 'business' ? 'business' : 'personal' };
        } catch (e) {
            return null;
        }
    }

    // 读标记记录：返回 { grantedBy, ts } 或 null
    async function readLabel(targetId) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent('label:' + targetId), { headers: KV_AUTH });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || typeof data.grantedBy !== 'string') return null;
            return { grantedBy: data.grantedBy, ts: typeof data.ts === 'number' ? data.ts : Date.now() };
        } catch (e) {
            return null;
        }
    }

    // 读头像（profile:<id>.avatar），失败返回 null
    async function readAvatar(id) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent('profile:' + id), { headers: KV_AUTH });
            if (!res.ok) return null;
            const data = await res.json();
            return (data && typeof data.avatar === 'string') ? data.avatar : null;
        } catch (e) {
            return null;
        }
    }

    // 读反向索引：返回 [targetId, ...]
    async function readGrantedList(grantedBy) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent('labels-by:' + grantedBy), { headers: KV_AUTH });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data.filter(x => typeof x === 'string') : [];
        } catch (e) {
            return [];
        }
    }

    async function writeGrantedList(grantedBy, list) {
        const res = await fetch(KV_URL + encodeURIComponent('labels-by:' + grantedBy), {
            method: 'PUT', headers: KV_HEADERS, body: JSON.stringify(list)
        });
        if (!res.ok) throw new Error('KV write failed: ' + res.status);
    }

    // 全局索引 labels:all → [{ targetId, grantedBy, ts }, ...]
    async function readAllLabels() {
        try {
            const res = await fetch(KV_URL + encodeURIComponent('labels:all'), { headers: KV_AUTH });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        } catch (e) {
            return [];
        }
    }

    async function writeAllLabels(list) {
        const res = await fetch(KV_URL + encodeURIComponent('labels:all'), {
            method: 'PUT', headers: KV_HEADERS, body: JSON.stringify(list)
        });
        if (!res.ok) throw new Error('KV write failed: ' + res.status);
    }

    try {
        // ================= GET =================
        if (request.method === 'GET') {
            const url = new URL(request.url, 'https://x.local');

            // 模式零：站长查全局标记列表 ?all=1&token=<站长token>
            const all = (url.searchParams.get('all') || '').toString().trim();
            if (all === '1' || all.toLowerCase() === 'true') {
                const token = (url.searchParams.get('token') || '').toString();
                const session = await parseToken(token);
                if (!session) {
                    return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
                }
                if (ADMINS.indexOf(session.id) === -1) {
                    return response.status(403).json({ ok: false, message: '没有权限' });
                }
                const labels = await readAllLabels();
                return response.status(200).json({ ok: true, labels: labels });
            }

            // 模式一：企业查自己授予过的列表 ?by=<企业ID>&token=<token>
            const by = (url.searchParams.get('by') || '').toString().trim().replace(/^@/, '');
            if (by) {
                if (!/^[a-zA-Z0-9]+$/.test(by)) {
                    return response.status(400).json({ ok: false, message: '参数不合法' });
                }
                const token = (url.searchParams.get('token') || '').toString();
                const session = await parseToken(token);
                if (!session) {
                    return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
                }
                // 只有该企业自己或站长能查
                if (session.id !== by && ADMINS.indexOf(session.id) === -1) {
                    return response.status(403).json({ ok: false, message: '没有权限' });
                }
                // 校验 by 确实是企业认证（防止伪造 ID 浪费查询）
                const vRec = await readVerified(by);
                if (!vRec || vRec.type !== 'business') {
                    return response.status(403).json({ ok: false, message: '该账号不是企业认证' });
                }
                const targets = await readGrantedList(by);
                return response.status(200).json({ ok: true, grantedBy: by, targets: targets });
            }

            // 模式二：公开批量查 ?ids=a,b,c（最多 50 个）
            const rawIds = (url.searchParams.get('ids') || '').toString().split(',');
            const ids = rawIds
                .map(x => x.trim().replace(/^@/, ''))
                .filter(x => /^[a-zA-Z0-9]+$/.test(x))
                .slice(0, 50);
            if (!ids.length) {
                return response.status(400).json({ ok: false, message: '参数不合法' });
            }

            const labelList = await Promise.all(ids.map(id => readLabel(id)));
            // 收集所有授予方 ID，批量拿头像（去重）
            const granterIds = Array.from(new Set(
                labelList.filter(x => x !== null).map(x => x.grantedBy)
            ));
            const avatarMap = {};
            await Promise.all(granterIds.map(async gid => {
                avatarMap[gid] = await readAvatar(gid);
            }));

            const labels = {};
            ids.forEach((id, i) => {
                const rec = labelList[i];
                if (rec !== null) {
                    labels[id] = {
                        grantedBy: rec.grantedBy,
                        ts: rec.ts,
                        grantedByAvatar: avatarMap[rec.grantedBy] || null
                    };
                }
            });
            return response.status(200).json({ ok: true, labels: labels });
        }

        // ================= POST：授予 / 撤销 =================
        if (request.method !== 'POST') {
            return response.status(405).json({ ok: false, message: '方法不允许' });
        }

        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const session = await parseToken(body && body.token);
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }

        const targetId = (body && body.targetId || '').toString().trim().replace(/^@/, '');
        if (!/^[a-zA-Z0-9]+$/.test(targetId)) {
            return response.status(400).json({ ok: false, message: '参数不合法' });
        }

        const action = (body && body.action || '').toString().trim().toLowerCase();
        const isAdmin = ADMINS.indexOf(session.id) !== -1;

        // ---- 授予标记 ----
        if (action === 'grant') {
            // 校验授予方是企业认证（站长豁免）
            if (!isAdmin) {
                const vRec = await readVerified(session.id);
                if (!vRec || vRec.type !== 'business') {
                    return response.status(403).json({ ok: false, message: '只有企业认证账号可以授予标记' });
                }
            }
            // 目标账号必须真实存在
            if (!(await findUserHash(targetId))) {
                return response.status(404).json({ ok: false, message: '用户不存在' });
            }
            // 目标不能是企业认证（避免双标记视觉冲突）
            const targetVerified = await readVerified(targetId);
            if (targetVerified && targetVerified.type === 'business') {
                return response.status(400).json({ ok: false, message: '不能给企业认证账号授予标记' });
            }
            // 目标已有标记则拒绝（每账号最多 1 个）
            const existing = await readLabel(targetId);
            if (existing) {
                return response.status(409).json({
                    ok: false,
                    message: '该账号已有标记（由 @' + existing.grantedBy + ' 授予），需先撤销'
                });
            }

            const now = Date.now();
            // 写 label:<targetId>
            const res1 = await fetch(KV_URL + encodeURIComponent('label:' + targetId), {
                method: 'PUT', headers: KV_HEADERS,
                body: JSON.stringify({ grantedBy: session.id, ts: now })
            });
            if (!res1.ok) throw new Error('KV write failed: ' + res1.status);

            // 追加反向索引 labels-by:<session.id>
            const list = await readGrantedList(session.id);
            if (list.indexOf(targetId) === -1) {
                list.push(targetId);
                await writeGrantedList(session.id, list);
            }

            // 追加全局索引 labels:all
            const all = await readAllLabels();
            if (!all.some(x => x && x.targetId === targetId)) {
                all.push({ targetId: targetId, grantedBy: session.id, ts: now });
                await writeAllLabels(all);
            }

            return response.status(200).json({ ok: true, targetId: targetId, action: 'grant', grantedBy: session.id });
        }

        // ---- 撤销标记 ----
        if (action === 'revoke') {
            const existing = await readLabel(targetId);
            if (!existing) {
                return response.status(404).json({ ok: false, message: '该账号没有标记' });
            }
            // 企业只能撤销自己授予的；站长可强制撤销任何
            if (!isAdmin && existing.grantedBy !== session.id) {
                return response.status(403).json({ ok: false, message: '只能撤销自己授予的标记' });
            }

            // 删 label:<targetId>
            await fetch(KV_URL + encodeURIComponent('label:' + targetId), {
                method: 'DELETE', headers: KV_AUTH
            });
            // 从反向索引移除
            const granterList = await readGrantedList(existing.grantedBy);
            const idx = granterList.indexOf(targetId);
            if (idx !== -1) {
                granterList.splice(idx, 1);
                await writeGrantedList(existing.grantedBy, granterList);
            }

            // 从全局索引移除
            const all = await readAllLabels();
            const filtered = all.filter(x => !(x && x.targetId === targetId));
            if (filtered.length !== all.length) {
                await writeAllLabels(filtered);
            }

            return response.status(200).json({ ok: true, targetId: targetId, action: 'revoke' });
        }

        return response.status(400).json({ ok: false, message: '未知操作' });
    } catch (e) {
        console.error('labels handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
