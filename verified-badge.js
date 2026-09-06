// 认证标记共用助手（闪电 + 断环，黑白线条）
// 图标源文件：verified.svg（512 viewBox，白描边透明底）
// 小尺寸展示时线条加粗、断口加宽（否则 14px 下断口和闪电会糊掉），几何与源文件一致
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

    // 认证标记：白色四角星（实心填充，源文件 verified.svg / auth.svg）
    // 实心填充在小尺寸下天然清晰，不像之前的断环+闪电线条要纠结线宽和断口
    var BADGE_SVG =
        '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="已认证">' +
        '<path d="M50 8 L58 42 L92 50 L58 58 L50 92 L42 58 L8 50 L42 42 Z" fill="var(--fg)"/>' +
        '</svg>';

    // 样式只注入一次：尺寸跟随名字字号（em），无需每页写 CSS
    function ensureStyle() {
        if (document.getElementById('verified-badge-style')) return;
        var style = document.createElement('style');
        style.id = 'verified-badge-style';
        style.textContent =
            '.verified-badge{display:inline-block;width:1.5em;height:1.5em;margin-left:0.28em;' +
            'vertical-align:-0.14em}' +
            '.verified-badge svg{display:block;width:100%;height:100%}';
        document.head.appendChild(style);
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
        svg: function () { return BADGE_SVG; },   // 页面里单独放图标时用（如「通过认证」入口框）

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
