// 认证标记共用助手 —— 渐变蓝四角星（#4DA3FF → #1D6BE0）
// 图标源文件：verified.svg / auth.svg（四角星）
//
// 用法：
//   VerifiedBadge.attach(nameEl, userId)   // 异步：命中认证才在元素末尾插入标记，返回 Promise<bool>
//   VerifiedBadge.check(['a','b'])         // 批量查，返回 Promise<Set>（含已认证的 id）
//
// 接口：GET /api/verified?ids=a,b,c → { ok, verified: { a: ts, ... } }（公开，无需登录）
// 同一页面多个 attach 会合并成一次请求（40ms 微批），同一 id 结果全页缓存
(function () {
    var cache = {};          // id -> 'personal' | 'business' | false（false 也是缓存，避免重复请求）
    var batch = {};          // id -> [resolveFn...]，等待合并的请求
    var batchScheduled = false;

    // 认证标记：四角星。个人=渐变蓝，企业=渐变金
    function badgeSvg(type) {
        var grad = type === 'business' ? 'vbadge-grad-gold' : 'vbadge-grad';
        return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="' +
            (type === 'business' ? '企业认证' : '已认证') + '">' +
            '<path d="M50 8 L58 42 L92 50 L58 58 L50 92 L42 58 L8 50 L42 42 Z" fill="url(#' + grad + ')"/>' +
            '</svg>';
    }

    // 样式与渐变定义各只注入一次
    function ensureStyle() {
        if (!document.getElementById('verified-badge-style')) {
            var style = document.createElement('style');
            style.id = 'verified-badge-style';
            style.textContent =
                '.verified-badge{display:inline-block;width:1.1em;height:1.1em;margin-left:0.25em;' +
                'vertical-align:-0.1em}' +
                '.verified-badge svg{display:block;width:100%;height:100%}';
            document.head.appendChild(style);
        }
        // 渐变蓝定义（全局唯一 id，所有四角星共用，避免重复 id）
        if (!document.getElementById('vbadge-defs')) {
            var defs = document.createElement('div');
            defs.id = 'vbadge-defs';
            defs.setAttribute('aria-hidden', 'true');
            defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
            defs.innerHTML =
                '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
                '<linearGradient id="vbadge-grad" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0" stop-color="#4DA3FF"/><stop offset="1" stop-color="#1D6BE0"/>' +
                '</linearGradient>' +
                '<linearGradient id="vbadge-grad-gold" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0" stop-color="#FFE55C"/><stop offset="1" stop-color="#FFB300"/>' +
                '</linearGradient></defs></svg>';
            document.body.appendChild(defs);
        }
    }

    function flushBatch() {
        batchScheduled = false;
        var ids = Object.keys(batch);
        var current = batch;
        batch = {};
        fetch('/api/verified?ids=' + encodeURIComponent(ids.join(',')))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var map = (data && data.ok && data.verified) ? data.verified : {};
                ids.forEach(function (id) {
                    var has = Object.prototype.hasOwnProperty.call(map, id);
                    var rec = has ? map[id] : null;
                    var type = (rec && rec.type === 'business') ? 'business' : 'personal';
                    cache[id] = has ? type : false;
                    (current[id] || []).forEach(function (fn) { fn(has); });
                });
            })
            .catch(function () {
                ids.forEach(function (id) {
                    (current[id] || []).forEach(function (fn) { fn(false); });
                });
            });
    }

    function checkOne(id) {
        if (id in cache) return Promise.resolve(cache[id]);
        if (!batch[id]) batch[id] = [];
        var fns = batch[id];
        return new Promise(function (resolve) {
            fns.push(resolve);
            if (!batchScheduled) {
                batchScheduled = true;
                setTimeout(flushBatch, 40);
            }
        });
    }

    window.VerifiedBadge = {
        svg: function () { ensureStyle(); return badgeSvg('personal'); },   // 页面里单独放图标时用（如「通过认证」入口框，默认蓝色个人认证）

        check: function (ids) {
            var self = this;
            var list = (Array.isArray(ids) ? ids : [ids])
                .map(function (x) { return String(x || '').trim().replace(/^@/, ''); })
                .filter(function (x) { return /^[a-zA-Z0-9]+$/.test(x); });
            return Promise.all(list.map(function (id) { return checkOne(id); })).then(function (flags) {
                var set = new Set();
                flags.forEach(function (ok, i) { if (ok) set.add(list[i]); });
                return set;
            });
        },

        attach: function (nameEl, userId) {
            var self = this;
            ensureStyle();
            return this.check(userId).then(function (set) {
                var id = String(userId).replace(/^@/, '');
                if (!set.has(id) || !nameEl || !nameEl.parentNode) return false;
                // 防重复插入（比如资料回填后再次调用）
                if (nameEl.querySelector('.verified-badge')) return true;
                var type = cache[id] === 'business' ? 'business' : 'personal';
                var span = document.createElement('span');
                span.className = 'verified-badge';
                span.title = type === 'business' ? '企业认证账号' : '已认证账号';
                span.innerHTML = badgeSvg(type);
                nameEl.appendChild(span);
                return true;
            }).catch(function () { return false; });
        }
    };
})();
