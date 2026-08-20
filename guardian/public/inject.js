/**
 * dsh-git-rescue — DSH 页面救援入口注入脚本（2026-08-21 新增）
 *
 * 用法：在 DSH 主页面（或任意页面）引入本脚本：
 *   <script src="http://<host>:3082/inject.js"></script>
 *
 * 行为：每 10s 轮询 guardian 的 /api/status，
 *  - DSH 状态非 running（down/degraded/stopped/recovering）→ 页面右上角弹横幅：
 *      「⚠️ DSH 异常 - 前往救援面板」→ 点击打开 guardian 救援面板（3082）
 *  - 状态恢复 running → 横幅自动消失
 *  - 与 DSH 页面隔离：不修改业务 DOM，只追加自身元素；失败静默（不报错）
 */
(function () {
  'use strict';
  if (window.__DSH_RESCUE_INJECT__) return;
  window.__DSH_RESCUE_INJECT__ = true;

  var GUARDIAN_BASE = 'http://' + (location.hostname || '127.0.0.1') + ':3082';
  var POLL_MS = 10000;
  var banner = null;
  var lastState = null;

  function ensureBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'dsh-rescue-inject-banner';
    banner.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'background:#7f1d1d', 'color:#fff', 'padding:12px 18px', 'border-radius:8px',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'font:14px/1.5 system-ui,sans-serif',
      'cursor:pointer', 'display:none', 'max-width:320px'
    ].join(';');
    banner.innerHTML =
      '<strong>⚠️ DSH 异常</strong><br>' +
      '<span id="dsh-rescue-inject-msg">检测到 DSH 状态异常</span><br>' +
      '<a id="dsh-rescue-inject-link" style="color:#fff;text-decoration:underline" ' +
      'href="' + GUARDIAN_BASE + '" target="_blank" rel="noopener">前往救援面板 →</a>';
    document.body.appendChild(banner);
  }

  function show(msg) {
    ensureBanner();
    var m = document.getElementById('dsh-rescue-inject-msg');
    if (m) m.textContent = msg || '检测到 DSH 状态异常';
    if (banner) banner.style.display = 'block';
  }

  function hide() {
    if (banner) banner.style.display = 'none';
  }

  function classify(dsh) {
    if (dsh === 'running') return null;
    if (dsh === 'recovering') return 'DSH 正在救援恢复中…';
    if (dsh === 'stopped') return 'DSH 已停止';
    return 'DSH 不可达或异常（' + (dsh || 'down') + '）';
  }

  function poll() {
    fetch(GUARDIAN_BASE + '/api/status', { method: 'GET', signal: AbortSignal.timeout(5000) })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (data) {
        var dsh = data && data.state && data.state.dsh;
        var msg = classify(dsh);
        if (msg) { lastState = 'bad'; show(msg); }
        else { lastState = 'ok'; hide(); }
      })
      .catch(function () {
        // guardian 自身不可达（可能整机异常）——不弹（避免误报），仅记录
        if (lastState === 'bad') hide();
        lastState = 'unreachable';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensureBanner(); poll(); });
  } else {
    ensureBanner();
    poll();
  }
  setInterval(poll, POLL_MS);
})();
