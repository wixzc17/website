// Static 主题切换：localStorage 手动偏好优先，否则跟随系统
// 用法：手动切换调 window.toggleTheme()；按钮由本脚本自动注入到 body 右上角
(function () {
    var KEY = 'static_theme'; // 'light' | 'dark' | 缺省 = 跟随系统
    var mq = window.matchMedia('(prefers-color-scheme: dark)');

    function resolve() {
        var s = null;
        try { s = localStorage.getItem(KEY); } catch (e) {}
        if (s === 'light' || s === 'dark') return s;
        return mq.matches ? 'dark' : 'light';
    }

    var cur = resolve();
    // 立即设置，避免页面先按默认夜间渲染再闪一下
    document.documentElement.setAttribute('data-theme', cur);

    var ICONS = {
        dark: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 14.5 A8 8 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z"/></svg>',
        light: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>'
    };

    function paint() {
        var btn = document.getElementById('theme-toggle');
        if (!btn) return;
        btn.innerHTML = ICONS[cur];
        btn.title = cur === 'dark' ? '切换到日间模式' : '切换到夜间模式';
    }

    window.toggleTheme = function () {
        cur = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', cur);
        try { localStorage.setItem(KEY, cur); } catch (e) {}
        paint();
    };

    // 系统主题变化：仅在没有手动偏好时跟随
    mq.addEventListener('change', function () {
        var s = null;
        try { s = localStorage.getItem(KEY); } catch (e) {}
        if (!s) {
            cur = resolve();
            document.documentElement.setAttribute('data-theme', cur);
            paint();
        }
    });

    function inject() {
        var btn = document.createElement('button');
        btn.id = 'theme-toggle';
        btn.className = 'theme-toggle';
        btn.type = 'button';
        btn.addEventListener('click', window.toggleTheme);
        document.body.appendChild(btn);
        paint();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
