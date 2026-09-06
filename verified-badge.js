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
    var cache = {};          // id -> true / false（false 也是缓存，避免重复请求）
    var batch = {};          // id -> [resolveFn...]，等待合并的请求
    var batchScheduled = false;

    // 认证标记：渐变蓝四角星，渐变定义见 ensureStyle 注入的全局 <linearGradient id="vbadge-grad">
    // （用全局唯一 id，避免每处内联 SVG 重复 id 互相覆盖）
    var BADGE_SVG =
        '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="已认证">' +
        '<path d="M50 8 L58 42 L92 50 L58 58 L50 92 L42 58 L8 50 L42 42 Z" fill="url(#vbadge-grad)"/>' +
        '</svg>';

    // 样式与渐变定义各只注入一次
    function ensureStyle() {
        if (!document.getElementById('verified-badge-style')) {
            var style = document.createElement('style');
            style.id = 'verified-badge-style';
            style.textContent =
                '.verified-badge{display:inline-block;width:2.4em;height:2.4em;margin-left:0.34em;' +
                'vertical-align:-0.24em}' +
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
                    cache[id] = has;
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
        svg: function () { ensureStyle(); return BADGE_SVG; },   // 页面里单独放图标时用（如「通过认证」入口框）

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
                var span = document.createElement('span');
                span.className = 'verified-badge';
                span.title = '已认证账号';
                span.innerHTML = BADGE_SVG;
                nameEl.appendChild(span);
                return true;
            }).catch(function () { return false; });
        }
    };
})();
