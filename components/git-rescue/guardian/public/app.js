/**
 * dsh-git-rescue guardian 网页控制
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

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
      recovering: ['救援中', 'rollback'],
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function loadStatus() {
    const r = await api('/api/status');
    if (!r.ok) return;
    setStatus(r.state.dsh);
    // v1.11.0：测试环境模式 + 待处理重启申请提示
    $('auto-flag').textContent = r.testHome
      ? '(测试环境：自动救援已禁用，崩溃由开发者自行解决)'
      : (r.config.autoRecover ? '(自动救援 开)' : '(自动救援 关)');
    const rr = r.restartRequest;
    const rrEl = $('restart-request-flag');
    if (rr && rr.status === 'pending') {
      rrEl.textContent = `⏸ 待处理重启申请：${rr.activeConversationCount} 个活跃对话（${rr.detail || ''}）。等对话结束后可点「手动救援」或删除申请文件。`;
      rrEl.className = 'msg warn';
      rrEl.style.display = '';
    } else {
      rrEl.style.display = 'none';
    }
    if (r.state.lastRecoveryResult) {
      const lr = r.state.lastRecoveryResult;
      setMsg(`上次救援: ${lr.ok ? '✅ 成功' : '❌ 失败'} ${lr.from || '?'} → ${lr.to} @ ${(lr.at || '').slice(0, 19)}`, lr.ok ? 'ok' : 'err');
    }
  }

  async function loadGitLog() {
    const r = await api('/api/gitlog?n=15');
    const list = $('git-list');
    $('git-count').textContent = r.ok ? `(${r.commits.length})` : '';
    if (!r.ok || r.commits.length === 0) {
      list.innerHTML = '<div class="empty">暂无 git 提交。先初始化 git-rescue 插件（设置 → 插件配置 → git 救援）。</div>';
      return;
    }
    list.innerHTML = '';
    for (const c of r.commits) {
      const div = document.createElement('div');
      div.className = 'commit';
      div.textContent = c;
      list.appendChild(div);
    }
  }

  async function loadLog() {
    const r = await api('/api/status');
    const el = $('log');
    if (!r.ok || !r.log || r.log.length === 0) {
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
      const r = await api('/api/status');
      setMsg('DSH: ' + (r.state.dsh === 'running' ? '✅ 正常' : '❌ 不可达/异常'), r.state.dsh === 'running' ? 'ok' : 'err');
      loadStatus();
    });
    $('btn-start').addEventListener('click', async () => {
      setMsg('正在启动 DSH …');
      const r = await api('/api/start', 'POST');
      setMsg(r.ok ? '启动请求已发出' : '启动失败', r.ok ? 'ok' : 'err');
      setTimeout(loadStatus, 2000);
    });
    $('btn-recover').addEventListener('click', async () => {
      if (!confirm('触发 git 救援？将 commit 坏现场 → 标记 bad → 回退到最后一个好提交 → 重启 DSH。')) return;
      setMsg('救援进行中，观察日志…');
      const r = await api('/api/recover', 'POST');
      setMsg(r.ok ? `✅ 救援完成，已回退到 ${r.to || '?'}` : `❌ ${r.error || '救援失败'}`, r.ok ? 'ok' : 'err');
      loadStatus();
      loadGitLog();
    });
    $('btn-clear-log').addEventListener('click', () => {
      $('log').innerHTML = '<div class="empty">已清空（服务端日志仍在）</div>';
    });
  }

  function start() {
    bindActions();
    loadStatus();
    loadGitLog();
    loadLog();
    setInterval(() => { loadStatus(); loadLog(); }, 5000);
  }

  document.addEventListener('DOMContentLoaded', start);
})();
