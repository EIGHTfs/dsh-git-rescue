/**
 * dsh-guardian 网页控制
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let refreshTimer = null;

  async function api(path, method, body) {
    const res = await fetch(path, {
      method: method || 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({ ok: false, error: 'bad response' }));
  }

  function setStatus(st) {
    const el = $('dsh-status');
    const map = {
      running: ['运行中', 'running'],
      stopped: ['已停止', 'stopped'],
      error: ['异常', 'error'],
      rollback: ['回退中', 'rollback'],
      unknown: ['未知', 'unknown'],
    };
    const [label, cls] = map[st] || map.unknown;
    el.textContent = label;
    el.className = 'badge ' + cls;
  }

  function setMsg(text, kind) {
    const el = $('action-msg');
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  async function loadStatus() {
    const r = await api('/api/status');
    if (!r.ok) return;
    setStatus(r.dsh);
    $('auto-flag').textContent = r.autoRollback ? '(自动回退 开)' : '(自动回退 关)';
    if (r.rollbackActive) {
      setStatus('rollback');
      setMsg('自动回退进行中，当前尝试: ' + (r.rollbackCurrent || '-'), '');
    }
    // 更新按钮状态
    $('btn-start').disabled = r.dsh === 'running';
  }

  async function loadSnapshots() {
    const r = await api('/api/snapshots');
    const list = $('snap-list');
    $('snap-count').textContent = r.ok ? `(${r.snapshots.length})` : '';
    if (!r.ok || r.snapshots.length === 0) {
      list.innerHTML = '<div class="empty">暂无快照。先安装 dsh-snapshot-archive 插件并创建快照。</div>';
      return;
    }
    list.innerHTML = '';
    for (const s of r.snapshots) {
      const div = document.createElement('div');
      div.className = 'snap';
      const time = (s.time || '').replace('T', ' ').slice(0, 19);
      div.innerHTML = `
        <span class="id">${escapeHtml(s.id)}</span>
        <span class="meta">${escapeHtml(time)} · ${escapeHtml(s.reason || '无备注')} · ${s.fileCount || 0} 文件</span>
        <span class="ops">
          <button class="restore" data-id="${escapeHtml(s.id)}">↩ 恢复</button>
        </span>`;
      div.querySelector('.restore').addEventListener('click', () => restoreSnap(s.id));
      list.appendChild(div);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function restoreSnap(id) {
    if (!confirm('恢复到快照 ' + id + '？当前配置将被覆盖，DSH 会重启。')) return;
    setMsg('正在恢复 ' + id + ' …');
    const r = await api('/api/restore', 'POST', { id });
    if (r.ok) {
      setMsg('已恢复 ' + id + '，DSH 状态: ' + (r.dshAfterStart === 'running' ? '✅ 正常' : '⏳ 启动中'), 'ok');
    } else {
      setMsg('恢复失败: ' + (r.error || '未知错误'), 'err');
    }
    setTimeout(() => { loadStatus(); loadSnapshots(); }, 1000);
  }

  async function loadLog() {
    const r = await api('/api/log');
    const el = $('log');
    if (!r.ok || r.log.length === 0) {
      el.innerHTML = '<div class="empty">暂无日志</div>';
      return;
    }
    el.innerHTML = '';
    for (const entry of r.log.slice(-100)) {
      const div = document.createElement('div');
      div.className = 'l ' + entry.level;
      const ts = (entry.time || '').slice(11, 19);
      div.textContent = `[${ts}] ${entry.msg}`;
      el.appendChild(div);
    }
    el.scrollTop = el.scrollHeight;
  }

  function bindActions() {
    $('btn-check').addEventListener('click', async () => {
      const r = await api('/api/check', 'POST');
      setMsg('DSH: ' + (r.dsh === 'running' ? '✅ 正常' : '❌ 不可达'), r.dsh === 'running' ? 'ok' : 'err');
      loadStatus();
    });

    $('btn-snapshot').addEventListener('click', () => {
      setMsg('请在 DSH 的 设置 → 插件配置 → 快照归档 中创建快照（guardian 只读取快照）。');
    });

    $('btn-start').addEventListener('click', async () => {
      setMsg('正在启动 DSH …');
      const r = await api('/api/start', 'POST');
      setMsg('启动请求完成: ' + (r.dshAfterStart === 'running' ? '✅ 正常' : '⏳ 等待健康检查'), 'ok');
      setTimeout(() => { loadStatus(); loadSnapshots(); }, 2000);
    });

    $('btn-stop').addEventListener('click', async () => {
      if (!confirm('停止 DSH？')) return;
      const r = await api('/api/stop', 'POST');
      setMsg(r.ok ? 'DSH 已停止' : '停止失败', r.ok ? 'ok' : 'err');
      loadStatus();
    });

    $('btn-rollback').addEventListener('click', async () => {
      if (!confirm('触发自动回退（从最新快照逐个恢复测试）？')) return;
      const r = await api('/api/rollback', 'POST', { reason: 'manual-web' });
      setMsg(r.ok ? '自动回退已触发，观察日志…' : '触发失败', r.ok ? 'ok' : 'err');
      loadStatus();
    });

    $('btn-clear-log').addEventListener('click', () => {
      $('log').innerHTML = '<div class="empty">已清空（服务端日志仍在）</div>';
    });
  }

  function start() {
    bindActions();
    loadStatus();
    loadSnapshots();
    loadLog();
    // 每 5 秒刷新状态 + 日志
    refreshTimer = setInterval(() => {
      loadStatus();
      loadLog();
      // 快照列表仅在非回退时轻量刷新
      if (document.visibilityState === 'visible') loadSnapshots();
    }, 5000);
  }

  document.addEventListener('DOMContentLoaded', start);
})();
