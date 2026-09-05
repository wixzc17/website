// Static AI 对话接口（智谱 GLM-4.7-Flash，永久免费模型）
//
// POST /api/ai  { token, messages }
//   messages: [{ role: 'user'|'assistant'|'system', content: '...' }]
//   返回 { ok: true, reply: '...' }
//
// 鉴权沿用会话 token（同 chat.js），API Key 只存服务端环境变量，
// 前端永远接触不到 Key —— 外人也无法调用这个接口

import crypto from 'crypto';

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    // ---------- 验证会话 token（与 chat.js 相同的签名逻辑） ----------
    function parseToken(token) {
        if (!token || typeof token !== 'string' || token.length > 512) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [id, ts, sig] = parts;
        if (!/^[a-zA-Z0-9]+$/.test(id) || !/^\d+$/.test(ts) || !/^[a-f0-9]{16}$/.test(sig)) return null;
        const age = Date.now() - parseInt(ts, 10);
        if (age < 0 || age > 7 * 24 * 3600 * 1000) return null;

        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) { return null; }
        const user = users[id];
        if (!user || !user.hash) return null;

        const material = id + '.' + ts + '.' + user.hash + '.static-salt';
        const expected = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
        if (sig !== expected) return null;

        return { id };
    }

    try {
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const session = parseToken(body && body.token);
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }

        if (!process.env.ZHIPU_API_KEY) {
            return response.status(500).json({ ok: false, message: 'AI 服务未配置' });
        }

        // 校验消息数组格式，限制长度防滥用
        const msgs = body && body.messages;
        if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > 40) {
            return response.status(400).json({ ok: false, message: '对话内容不合法' });
        }
        const clean = [];
        for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : null;
            const content = typeof m.content === 'string' ? m.content.slice(0, 4000) : null;
            if (role && content && content.trim()) {
                clean.push({ role, content });
            }
        }
        if (clean.length === 0) {
            return response.status(400).json({ ok: false, message: '对话内容不合法' });
        }

        // ---------- 调用智谱 OpenAI 兼容接口 ----------
        const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + process.env.ZHIPU_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'glm-4.7-flash',
                messages: clean,
                temperature: 0.7,
                max_tokens: 1024
            })
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('zhipu api error:', res.status, errText.slice(0, 500));
            return response.status(502).json({ ok: false, message: 'AI 服务暂时不可用' });
        }

        const data = await res.json();
        const reply = data && data.choices && data.choices[0] &&
                      data.choices[0].message && data.choices[0].message.content;

        if (typeof reply !== 'string' || !reply.trim()) {
            return response.status(502).json({ ok: false, message: 'AI 没有返回内容' });
        }

        return response.status(200).json({ ok: true, reply });
    } catch (e) {
        console.error('ai handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
