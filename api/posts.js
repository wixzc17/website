// Static 推文广场接口 —— 公开内容系统（发推 / 推文流 / 点赞 / 评论 / 删除）
//
// 数据模型（Cloudflare KV）：
//   post:<ts>.<author>.<rand>  →  { author, text, ts }        单条推文（id 里带作者，删除时可校验归属）
//   posts:feed                 →  [postId, ...]               全局推文流（倒序，新帖插最前，上限 200）
//   like:<postId>              →  [userId, ...]               点赞名单
//   comment:<postId>           →  [{ id, from, text, ts }...] 评论（每条上限 500）
//
// 接口（均需登录 token，广场页未登录会先跳登录）：
//   GET    /api/posts?token=xxx                 → { ok, posts: [{ id, author, name, avatar, text, ts, likeCount, likedByMe, commentCount }] }
//   POST   /api/posts { token, text }           → 发推（1-500 字）
//   DELETE /api/posts?token=xxx&id=xxx          → 删自己的推文（id 里 author 必须是本人）
//   POST   /api/posts/like { token, postId }    → 点赞/取消点赞（toggle）→ { ok, liked, likeCount }
//   GET    /api/posts/comments?postId=xxx&token=xxx  → { ok, comments: [{ id, from, name, text, ts }] }
//   POST   /api/posts/comment { token, postId, text } → 发评论（1-500 字）
//
// 推文是公开广播，不做加密（加密属于私聊）；防冒充后续用 v2 身份密钥做作者签名（本期未做）。

import crypto from 'crypto';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
const KV_AUTH = { 'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}` };
const KV_HEADERS = {
    'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
    'Content-Type': 'application/json'
};

const FEED_KEY = 'posts:feed';
const MAX_TEXT = 500;
const MAX_FEED = 200;
const MAX_COMMENTS = 500;

export default async function handler(request, response) {
    // 查找账号：STATIC_USERS 优先，KV 注册账号兜底
    async function findAccount(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].hash) return { name: users[id].name, hash: users[id].hash, ts: users[id].ts };
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), { headers: KV_AUTH });
            if (res.ok) {
                const acct = await res.json();
                if (acct && typeof acct.hash === 'string') return { name: acct.name, hash: acct.hash, ts: acct.ts };
            }
        } catch (e) {}
        return null;
    }

    // 验证会话 token（与 profile.js 相同签名），返回 { id } 或 null
    async function parseToken(token) {
        if (!token || typeof token !== 'string' || token.length > 512) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [id, ts, sig] = parts;
        if (!/^[a-zA-Z0-9]+$/.test(id) || !/^\d+$/.test(ts) || !/^[a-f0-9]{16}$/.test(sig)) return null;
        const age = Date.now() - parseInt(ts, 10);
        if (age < 0 || age > 7 * 24 * 3600 * 1000) return null;

        const account = await findAccount(id);
        if (!account || !account.hash) return null;

        const material = id + '.' + ts + '.' + account.hash + '.static-salt';
        const expected = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
        if (sig !== expected) return null;
        return { id };
    }

    async function readJSON(key, fallback) {
        const res = await fetch(KV_URL + encodeURIComponent(key), { headers: KV_AUTH });
        if (res.status === 404) return fallback;
        if (!res.ok) throw new Error('KV read failed: ' + res.status);
        return await res.json();
    }

    async function writeJSON(key, val) {
        const res = await fetch(KV_URL + encodeURIComponent(key), {
            method: 'PUT', headers: KV_HEADERS, body: JSON.stringify(val)
        });
        if (!res.ok) throw new Error('KV write failed: ' + res.status);
    }

    async function deleteKV(key) {
        await fetch(KV_URL + encodeURIComponent(key), { method: 'DELETE', headers: KV_AUTH });
    }

    // 解析显示名 + 头像：profile:<id> 优先，回退账号注册名，再回退 @id
    async function resolveAuthor(id) {
        let name = null, avatar = null;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('profile:' + id), { headers: KV_AUTH });
            if (res.ok) {
                const p = await res.json();
                if (p) { name = p.name; avatar = p.avatar || null; }
            }
        } catch (e) {}
        if (!name) {
            const acct = await findAccount(id);
            if (acct) name = acct.name;
        }
        return { name: name || ('@' + id), avatar: avatar };
    }

    // postId 合法性：<数字>.<字母数字作者>.<小写字母数字随机>
    function validPostId(id) {
        return typeof id === 'string' && /^\d+\.[a-zA-Z0-9]+\.[a-z0-9]{2,8}$/.test(id);
    }

    try {
        // ================= GET /api/posts —— 推文流 / 评论列表 =================
        // 评论列表用 ?comments=<postId> 区分（子路径 /api/posts/comments 在 Vercel 上不会路由到本函数）
        if (request.method === 'GET') {
            const url = new URL(request.url, 'https://x.local');
            const session = await parseToken(url.searchParams.get('token') || '');
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }

            // ---- 评论列表 ----
            const commentsPostId = url.searchParams.get('comments') || '';
            if (commentsPostId) {
                if (!validPostId(commentsPostId)) {
                    return response.status(400).json({ ok: false, message: '参数不合法' });
                }
                let comments = [];
                try { comments = await readJSON('comment:' + commentsPostId, []); } catch (e) {}
                if (!Array.isArray(comments)) comments = [];

                const fromSet = [...new Set(comments.map(c => c && c.from).filter(Boolean))];
                const nameMap = {};
                await Promise.all(fromSet.map(async (f) => {
                    const info = await resolveAuthor(f);
                    nameMap[f] = info.name;
                }));
                const out = comments.map(c => ({
                    id: c.id, from: c.from, text: c.text, ts: c.ts,
                    name: nameMap[c.from] || ('@' + c.from)
                }));
                return response.status(200).json({ ok: true, comments: out });
            }

            // ---- 推文流 ----
            let feed = [];
            try { feed = await readJSON(FEED_KEY, []); } catch (e) { feed = []; }
            if (!Array.isArray(feed)) feed = [];

            // 并发读每条推文 + 点赞 + 评论数
            const rows = await Promise.all(feed.map(async (id) => {
                try {
                    const p = await readJSON('post:' + id, null);
                    if (!p || typeof p.text !== 'string') return null;
                    let likes = [];
                    let comments = [];
                    try { likes = await readJSON('like:' + id, []); } catch (e) {}
                    try { comments = await readJSON('comment:' + id, []); } catch (e) {}
                    return {
                        id: id,
                        author: p.author,
                        text: p.text,
                        ts: p.ts,
                        likeCount: Array.isArray(likes) ? likes.length : 0,
                        likedByMe: Array.isArray(likes) ? likes.indexOf(session.id) !== -1 : false,
                        commentCount: Array.isArray(comments) ? comments.length : 0
                    };
                } catch (e) {
                    return null;
                }
            }));

            const posts = rows.filter(Boolean);

            // 批量解析作者 name/avatar（去重）
            const authorSet = [...new Set(posts.map(p => p.author))];
            const authorMap = {};
            await Promise.all(authorSet.map(async (a) => {
                authorMap[a] = await resolveAuthor(a);
            }));
            posts.forEach(p => {
                const info = authorMap[p.author] || { name: '@' + p.author, avatar: null };
                p.name = info.name;
                p.avatar = info.avatar;
            });

            return response.status(200).json({ ok: true, posts: posts });
        }

        // ================= DELETE /api/posts —— 删自己的推文 =================
        if (request.method === 'DELETE') {
            const url = new URL(request.url, 'https://x.local');
            const session = await parseToken(url.searchParams.get('token') || '');
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }
            const id = url.searchParams.get('id') || '';
            if (!validPostId(id)) {
                return response.status(400).json({ ok: false, message: '参数不合法' });
            }
            // postId = <ts>.<author>.<rand>，author 必须是本人
            const author = id.split('.')[1];
            if (author !== session.id) {
                return response.status(403).json({ ok: false, message: '只能删除自己的推文' });
            }
            await deleteKV('post:' + id);
            await deleteKV('like:' + id);
            await deleteKV('comment:' + id);
            let feed = [];
            try { feed = await readJSON(FEED_KEY, []); } catch (e) {}
            await writeJSON(FEED_KEY, Array.isArray(feed) ? feed.filter(x => x !== id) : []);
            return response.status(200).json({ ok: true });
        }

        // ================= POST —— 发推 / 点赞 / 评论 =================
        if (request.method === 'POST') {
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            const session = await parseToken(body && body.token);
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }

            // ---- 点赞 / 取消点赞 ----
            if (body && body.action === 'like') {
                const postId = body.postId;
                if (!validPostId(postId)) {
                    return response.status(400).json({ ok: false, message: '参数不合法' });
                }
                let likes = [];
                try { likes = await readJSON('like:' + postId, []); } catch (e) {}
                if (!Array.isArray(likes)) likes = [];
                const idx = likes.indexOf(session.id);
                let liked;
                if (idx !== -1) { likes.splice(idx, 1); liked = false; }
                else { likes.push(session.id); liked = true; }
                await writeJSON('like:' + postId, likes);
                return response.status(200).json({ ok: true, liked: liked, likeCount: likes.length });
            }

            // ---- 发评论 ----
            if (body && body.action === 'comment') {
                const postId = body.postId;
                const text = (body.text || '').toString().trim();
                if (!validPostId(postId)) {
                    return response.status(400).json({ ok: false, message: '参数不合法' });
                }
                if (!text || text.length > MAX_TEXT) {
                    return response.status(400).json({ ok: false, message: '评论需为 1-' + MAX_TEXT + ' 字' });
                }
                let comments = [];
                try { comments = await readJSON('comment:' + postId, []); } catch (e) {}
                if (!Array.isArray(comments)) comments = [];
                const c = {
                    id: Date.now() + '.' + session.id + '.' + Math.random().toString(36).slice(2, 6),
                    from: session.id, text: text, ts: Date.now()
                };
                comments.push(c);
                if (comments.length > MAX_COMMENTS) comments = comments.slice(-MAX_COMMENTS);
                await writeJSON('comment:' + postId, comments);
                return response.status(200).json({ ok: true, comment: { id: c.id, from: c.from, text: c.text, ts: c.ts } });
            }

            // ---- 发推 ----
            const text = (body && body.text || '').toString().trim();
            if (!text || text.length > MAX_TEXT) {
                return response.status(400).json({ ok: false, message: '推文需为 1-' + MAX_TEXT + ' 字' });
            }
            const ts = Date.now();
            const id = ts + '.' + session.id + '.' + Math.random().toString(36).slice(2, 6);
            await writeJSON('post:' + id, { author: session.id, text: text, ts: ts });

            let feed = [];
            try { feed = await readJSON(FEED_KEY, []); } catch (e) {}
            if (!Array.isArray(feed)) feed = [];
            feed.unshift(id);
            if (feed.length > MAX_FEED) feed = feed.slice(0, MAX_FEED);
            await writeJSON(FEED_KEY, feed);

            return response.status(200).json({ ok: true, post: { id: id, author: session.id, text: text, ts: ts } });
        }

        return response.status(405).json({ ok: false, message: '方法不允许' });
    } catch (e) {
        console.error('posts handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
