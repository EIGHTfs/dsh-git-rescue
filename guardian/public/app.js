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
    // 手动停止标志：提示当前处于"已手动停止、自动守护暂停"状态（旧版 /api/stop 语义）
    const stopFlag = $('manual-stop-flag');
    if (r.state.manualStop) {
      stopFlag.textContent = '⏸ 已手动停止：自动救援/拉起已暂停（点「启动 DSH」恢复自动守护）';
      stopFlag.className = 'msg warn';
      stopFlag.style.display = '';
      $('btn-start').disabled = false;
    } else {
      stopFlag.style.display = 'none';
      $('btn-start').disabled = r.state.dsh === 'running';
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

  async function loadAuth() {
    const r = await api('/api/auth');
    const el = $('auth-status');
    if (!r.ok) { el.textContent = '认证状态读取失败'; el.className = 'msg err'; return; }
    const parts = [];
    if (r.method === 'ssh') {
      parts.push('✅ SSH key 可用（' + r.sshKeyDir + '）');
    } else if (r.method === 'token') {
      parts.push('✅ GitHub token 已配置（' + (r.tokenMasked || '') + '，来源 ' + (r.tokenSource || '') + '）');
    } else {
      parts.push('⚠️ 未配置远端认证（远端备份/自更新需 token 或 SSH key）');
    }
    parts.push('当前方案: ' + r.method);
    el.textContent = parts.join(' · ');
    el.className = 'msg ' + (r.method === 'none' ? 'warn' : 'ok');
  }

  async function loadAdminPw() {
    const r = await api('/api/admin-password');
    const el = $('admin-pw-status');
    if (!r.ok) { el.textContent = '读取失败'; el.className = 'msg err'; return; }
    el.textContent = r.configured
      ? '✅ 已配置（data/sensitive/admin-password，600 权限；开启 SSH 时自动提权）'
      : '⚠️ 未配置（Windows 上开启 SSH 需要管理员权限，可在此填写）';
    el.className = 'msg ' + (r.configured ? 'ok' : 'warn');
  }

  // ===== web 多选备份（会话/skill 定向备份，2026-08-20）=====
  // 目录树数据 + 已勾选集合
  let bsTreeData = null;
  let bsSelected = new Set();

  // 递归收集目录路径（相对 root）
  function collectDirPaths(node, prefix) {
    const out = [];
    const path = prefix ? prefix + '/' + node.name : node.name;
    if (node.children && node.children.length) {
      for (const kid of node.children) {
        if (kid.isDir || kid.children) out.push(...collectDirPaths(kid, path));
        else out.push(path); // 文件归属其所在目录
      }
    }
    return out;
  }

  // 递归渲染 checkbox 树
  function renderTree(node, prefix, container) {
    const path = prefix ? prefix + '/' + node.name : node.name;
    const hasKids = node.children && node.children.length > 0;
    const labelText = node.name + (hasKids ? '/' : '');
    const lab = document.createElement('label');
    lab.style.paddingLeft = (prefix ? 14 : 0) + 'px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = bsSelected.has(path);
    cb.addEventListener('change', () => {
      if (cb.checked) bsSelected.add(path);
      else bsSelected.delete(path);
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(labelText));
    container.appendChild(lab);
    if (hasKids) {
      for (const kid of node.children) renderTree(kid, path, container);
    }
  }

  async function loadBackupSelect() {
    const st = $('bs-status');
    st.textContent = '加载目录树…';
    st.className = 'msg dim';
    const treeR = await api('/api/backup-select/tree');
    const cfgR = await api('/api/backup-select');
    const box = $('bs-tree');
    box.innerHTML = '';
    if (!treeR.ok || !treeR.tree) {
      st.textContent = '目录树加载失败: ' + (treeR.error || '未知');
      st.className = 'msg err';
      return;
    }
    bsTreeData = treeR.tree;
    bsSelected = new Set((cfgR.config && cfgR.config.selected) || []);
    // 只渲染 sessions / skills / profiles 等顶层目录
    const kids = bsTreeData.children || [];
    for (const kid of kids) renderTree(kid, '', box);
    st.textContent = '勾选要备份的会话 / skill 目录（已保存配置已回显）→ 保存 → 应用 .gitignore → 推送';
    st.className = 'msg ok';
  }

  function bindActions() {
    $('btn-check').addEventListener('click', async () => {
      const r = await api('/api/status');
      setMsg('DSH: ' + (r.state.dsh === 'running' ? '✅ 正常' : '❌ 不可达/异常'), r.state.dsh === 'running' ? 'ok' : 'err');
      loadStatus();
    });
    $('btn-save-token').addEventListener('click', async () => {
      const tok = $('token-input').value.trim();
      if (!tok) { $('auth-msg').textContent = '请输入 token'; $('auth-msg').className = 'msg err'; return; }
      $('auth-msg').textContent = '保存中…';
      const r = await api('/api/auth', 'POST', { githubToken: tok });
      if (r.ok) {
        $('auth-msg').textContent = '✅ token 已保存（600 权限，仅本地）';
        $('auth-msg').className = 'msg ok';
        $('token-input').value = '';
        loadAuth();
      } else {
        $('auth-msg').textContent = '❌ ' + (r.error || '保存失败');
        $('auth-msg').className = 'msg err';
      }
    });
    $('btn-save-admin-pw').addEventListener('click', async () => {
      const pw = $('admin-pw-input').value;
      if (!pw) { $('admin-pw-msg').textContent = '请输入管理员密码'; $('admin-pw-msg').className = 'msg err'; return; }
      $('admin-pw-msg').textContent = '保存中…';
      const r = await api('/api/admin-password', 'POST', { adminPassword: pw });
      if (r.ok) {
        $('admin-pw-msg').textContent = '✅ 管理员密码已保存（600 权限，仅本机，不进 git）';
        $('admin-pw-msg').className = 'msg ok';
        $('admin-pw-input').value = '';
        loadAdminPw();
      } else {
        $('admin-pw-msg').textContent = '❌ ' + (r.error || '保存失败');
        $('admin-pw-msg').className = 'msg err';
      }
    });
    $('btn-clear-admin-pw').addEventListener('click', async () => {
      if (!confirm('清除已保存的管理员密码？')) return;
      const r = await api('/api/admin-password', 'POST', { clear: true });
      $('admin-pw-msg').textContent = r.ok ? '✅ 已清除' : '❌ ' + (r.error || '清除失败');
      $('admin-pw-msg').className = r.ok ? 'msg ok' : 'msg err';
      loadAdminPw();
    });
    // ---- web 多选备份按钮 ----
    $('bs-select-all').addEventListener('click', () => {
      document.querySelectorAll('#bs-tree input[type=checkbox]').forEach((cb) => { cb.checked = true; });
      // 重新收集全部目录路径
      if (bsTreeData) {
        bsSelected = new Set();
        (bsTreeData.children || []).forEach((k) => collectDirPaths(k, '').forEach((p) => bsSelected.add(p)));
      }
    });
    $('bs-select-none').addEventListener('click', () => {
      document.querySelectorAll('#bs-tree input[type=checkbox]').forEach((cb) => { cb.checked = false; });
      bsSelected = new Set();
    });
    $('bs-save').addEventListener('click', async () => {
      const selected = [...bsSelected].filter(Boolean);
      const r = await api('/api/backup-select', 'POST', { root: '', selected });
      $('bs-msg').textContent = r.ok ? `✅ 已保存 ${selected.length} 个目录勾选` : '❌ ' + (r.error || '保存失败');
      $('bs-msg').className = r.ok ? 'msg ok' : 'msg err';
    });
    $('bs-apply').addEventListener('click', async () => {
      const r = await api('/api/backup-select/apply', 'POST', {});
      $('bs-msg').textContent = r.ok ? `✅ .gitignore 已按勾选生成（${r.selectedCount} 个目录）` : '❌ ' + (r.error || '应用失败');
      $('bs-msg').className = r.ok ? 'msg ok' : 'msg err';
    });
    $('bs-push').addEventListener('click', async () => {
      if (!confirm('按当前勾选推送到远端备份仓？')) return;
      $('bs-msg').textContent = '推送中…（可能较慢）';
      const r = await api('/api/backup-select/push', 'POST', {});
      $('bs-msg').textContent = r.ok ? `✅ 已推送 ${r.selectedCount} 个目录到备份仓` : '❌ ' + (r.error || '推送失败');
      $('bs-msg').className = r.ok ? 'msg ok' : 'msg err';
    });
    $('btn-start').addEventListener('click', async () => {
      setMsg('正在启动 DSH …');
      const r = await api('/api/start', 'POST');
      setMsg(r.ok ? '启动请求已发出' : '启动失败', r.ok ? 'ok' : 'err');
      setTimeout(loadStatus, 2000);
    });
    $('btn-stop').addEventListener('click', async () => {
      if (!confirm('停止 DSH？停止后自动救援/拉起将暂停，需手动点「启动 DSH」恢复。')) return;
      setMsg('正在停止 DSH …');
      const r = await api('/api/stop', 'POST');
      setMsg(r.ok ? '✅ DSH 已停止（自动守护已暂停）' : '❌ 停止失败', r.ok ? 'ok' : 'err');
      loadStatus();
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
    loadAuth();
    loadAdminPw();
    loadBackupSelect();
    loadGitLog();
    loadLog();
    setInterval(() => { loadStatus(); loadLog(); }, 5000);
  }

  document.addEventListener('DOMContentLoaded', start);
})();
