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
    // 2.5.0：手动关闭自动救援开关状态（网页按钮互斥显示）
    const offBtn = $('btn-auto-recover-off');
    const onBtn = $('btn-auto-recover-on');
    if (r.state.autoRecoverOff) {
      offBtn.style.display = 'none';
      onBtn.style.display = '';
    } else {
      offBtn.style.display = '';
      onBtn.style.display = 'none';
    }
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
      $('btn-stop').disabled = true;
    } else {
      stopFlag.style.display = 'none';
      $('btn-start').disabled = r.state.dsh === 'running';
      $('btn-stop').disabled = r.state.dsh !== 'running';
    }
  }

  async function loadGitLog() {
    const r = await api('/api/gitlog?n=30');
    const list = $('git-list');
    $('git-count').textContent = r.ok ? `(${r.commits.length} 提交${r.badCount ? ' · ' + r.badCount + ' 个失败标记' : ''})` : '';
    if (!r.ok || r.commits.length === 0) {
      list.innerHTML = '<div class="empty">暂无 git 提交。先初始化 git-rescue 插件（设置 → 插件配置 → git 救援）。</div>';
      return;
    }
    list.innerHTML = '';
    for (const c of r.commits) {
      const div = document.createElement('div');
      div.className = 'commit' + (c.bad ? ' bad' : '') + (c.current ? ' current' : '');
      // 左侧信息区
      const info = document.createElement('span');
      info.className = 'commit-info';
      info.innerHTML =
        (c.current ? '<span class="tag cur">当前</span>' : '') +
        (c.bad ? '<span class="tag bad">✗ 恢复失败</span>' : '') +
        `<span class="hash">${c.short}</span>` +
        `<span class="msg">${escapeHtml(c.message)}</span>`;
      div.appendChild(info);
      // 右侧回退按钮（非 bad、非当前 才可回退）
      if (!c.bad && !c.current) {
        const btn = document.createElement('button');
        btn.className = 'rb-btn';
        btn.textContent = '↩ 回退';
        btn.addEventListener('click', async () => {
          if (!confirm(`回退到 ${c.short}？\n将 commit 当前现场 → 标记 bad → git reset --hard。`)) return;
          const rr = await api('/api/gitlog/rollback', 'POST', { ref: c.hash });
          alert(rr.ok ? `✅ 已回退到 ${rr.to}` : `❌ ${rr.error || '回退失败'}`);
          loadGitLog();
          loadStatus();
        });
        div.appendChild(btn);
      }
      list.appendChild(div);
    }
  }

  async function loadLog() {
    // 用户点过「清空日志显示」后跳过自动重绘（直到页面刷新），不再 5s 后又刷回来
    if (logCleared) return;
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
      const ts = entry.timeLocal || (entry.time || '').slice(11, 19);
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
    if (r.method === 'token') {
      parts.push('✅ GitHub token 已配置（' + (r.tokenMasked || '') + '，来源 ' + (r.tokenSource || '') + '）');
    } else {
      parts.push('⚠️ 未配置远端认证（远端备份需 GitHub token）');
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
      ? '✅ 已配置（data/sensitive/admin-password，600 权限）'
      : '⚠️ 未配置（Windows / macOS / Linux 系统提权需要管理员密码时可在此填写）';
    el.className = 'msg ' + (r.configured ? 'ok' : 'warn');
  }

  // ===== web 多选备份（会话/skill 定向备份，2026-08-20）=====
  // ===== 备份内容选择（类别式：profile 必选 + session/skill/api 多选，2026-08-21 重写）=====
  let bsCfg = { profile: true, session: true, skill: true, api: true };
  let logCleared = false; // 用户清空日志显示后跳过自动重绘（刷新页面恢复）

  // 渲染类别勾选框（profile 锁定必选）
  function renderBackupSelectCats(cfg, categories) {
    const box = $('bs-cats');
    box.innerHTML = '';
    const order = ['profile', 'session', 'skill', 'api'];
    for (const key of order) {
      const cat = (categories && categories[key]) || { label: key, fixed: false, desc: '' };
      const lab = document.createElement('label');
      lab.className = 'bs-cat';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!cfg[key];
      cb.disabled = !!cat.fixed; // profile 必选，不可取消
      cb.dataset.cat = key;
      cb.addEventListener('change', () => { bsCfg[key] = cb.checked; });
      lab.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = (cat.fixed ? '🔒 ' : '') + cat.label;
      lab.appendChild(txt);
      if (cat.desc) {
        const desc = document.createElement('div');
        desc.className = 'bs-cat-desc';
        desc.textContent = cat.desc;
        lab.appendChild(desc);
      }
      box.appendChild(lab);
    }
  }

  async function loadBackupSelect() {
    const st = $('bs-msg');
    st.textContent = '加载配置…';
    st.className = 'msg dim';
    const r = await api('/api/backup-select');
    if (!r.ok) {
      st.textContent = '加载失败: ' + (r.error || '未知');
      st.className = 'msg err';
      return;
    }
    bsCfg = Object.assign({ profile: true, session: true, skill: true, api: true }, r.config || {});
    renderBackupSelectCats(bsCfg, r.categories);
    st.textContent = '选择要备份的内容：profile 必选，会话 / 技能 / 配置可多选 → 保存 → 应用 .gitignore → 推送';
    st.className = 'msg ok';
  }

  // ===== 守护进程重启方案（web 多选共同启用，2026-08-21）=====
  async function loadProtection() {
    const r = await api('/api/protection');
    const box = $('prot-list');
    if (!r.ok || !r.methods) {
      box.innerHTML = '<div class="empty">加载失败</div>';
      return;
    }
    box.innerHTML = '';
    for (const m of r.methods) {
      const div = document.createElement('div');
      div.className = 'prot-item' + (m.available ? '' : ' pending');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!m.enabled;
      cb.disabled = false; // 2026-08-21：不可用也可勾选，保存时检测可用性再生效
      cb.dataset.mid = m.id;
      cb.addEventListener('change', () => { /* 保存时统一读取 */ });
      div.appendChild(cb);
      const lab = document.createElement('span');
      lab.className = 'p-label';
      lab.textContent = (m.available ? '' : '⏳ ') + m.label;
      div.appendChild(lab);
      const desc = document.createElement('span');
      desc.className = 'p-desc';
      desc.textContent = m.desc + (m.available ? '' : '（本环境当前不可用，勾选后可用时自动生效）');
      div.appendChild(desc);
      const state = document.createElement('span');
      state.className = 'p-state ' + (m.available ? (m.running ? 'on' : 'off') : 'na');
      state.textContent = m.available ? (m.running ? '运行中' : '未运行') : '待可用';
      div.appendChild(state);
      box.appendChild(div);
    }
  }

  // ===== 救援环境安装器（2026-08-21）=====
  async function loadInstaller() {
    const r = await api('/api/installer/status');
    const st = $('installer-status');
    if (!r.ok) {
      st.textContent = '状态读取失败: ' + (r.error || '未知');
      st.className = 'status err';
      return;
    }
    const parts = [`远端: v${r.remote || '?'}`];
    parts.push(`测试环境: v${(r.testEnv && r.testEnv.version) || '未装'}`);
    parts.push(`纯净环境: v${(r.cleanEnv && r.cleanEnv.version) || '未装'}`);
    if (r.updateNeeded) parts.push('⚠️ 版本不一致，可安装');
    st.textContent = parts.join(' · ');
    st.className = 'status ' + (r.updateNeeded ? 'err' : 'ok');
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
    // ---- 备份内容选择按钮（类别式，2026-08-21）----
    $('bs-save').addEventListener('click', async () => {
      const r = await api('/api/backup-select', 'POST', {
        session: bsCfg.session,
        skill: bsCfg.skill,
        api: bsCfg.api,
      });
      $('bs-msg').textContent = r.ok
        ? '✅ 已保存：profile 必选 + ' + ['session', 'skill', 'api'].filter((k) => bsCfg[k]).join(' / ') || '（无额外项）'
        : '❌ ' + (r.error || '保存失败');
      $('bs-msg').className = r.ok ? 'msg ok' : 'msg err';
    });
    $('bs-apply').addEventListener('click', async () => {
      const r = await api('/api/backup-select/apply', 'POST', {});
      $('bs-msg').textContent = r.ok ? `✅ .gitignore 已按选择生成（${r.selectedCount} 个路径，profile 必选）` : '❌ ' + (r.error || '应用失败');
      $('bs-msg').className = r.ok ? 'msg ok' : 'msg err';
    });
    $('bs-push').addEventListener('click', async () => {
      if (!confirm('按当前选择推送到远端备份库（设备ID文件夹内）？')) return;
      $('bs-msg').textContent = '推送中…（可能较慢）';
      const r = await api('/api/backup-select/push', 'POST', {});
      $('bs-msg').textContent = r.ok
        ? `✅ 已推送 ${r.files || 0} 文件到 ${r.repo || ''}/${r.deviceDir || ''}/`
        : '❌ ' + (r.error || '推送失败');
      $('bs-msg').className = r.ok ? 'msg ok' : 'msg err';
      loadBackupStatus();
    });
    // ---- 从远端拉取恢复（2026-08-21）----
    $('fetch-list').addEventListener('click', async () => {
      const st = $('fetch-status');
      st.textContent = '预览中…';
      st.className = 'status dim';
      const r = await api('/api/backup/fetch');
      const box = $('fetch-list-box');
      box.style.display = 'block';
      if (!r.ok || !r.list) {
        st.textContent = '❌ ' + (r.error || '预览失败');
        st.className = 'status err';
        box.innerHTML = '';
        return;
      }
      st.textContent = `✅ 远端 ${r.repo}/${r.deviceId}/ 共 ${r.files} 个文件`;
      st.className = 'status ok';
      box.innerHTML = (r.list || []).map((f) =>
        `<div class="item"><span class="icon">📄</span><span class="name">${escapeHtml(f.rel)}</span><span class="status-text">${f.size} B</span></div>`
      ).join('') || '<div class="empty">（无文件）</div>';
    });
    $('fetch-restore').addEventListener('click', async () => {
      if (!confirm('从远端备份库拉取并覆盖写入本地 .dsh？将覆盖当前同路径文件。')) return;
      const st = $('fetch-status');
      st.textContent = '拉取恢复中…';
      st.className = 'status dim';
      const r = await api('/api/backup/fetch', 'POST', {});
      if (r.ok) {
        st.textContent = `✅ 已拉取恢复 ${r.files} 个文件`;
        st.className = 'status ok';
      } else {
        st.textContent = '❌ ' + (r.error || '拉取失败');
        st.className = 'status err';
      }
      loadBackupStatus();
    });
    // 守护方案：保存并应用（读取勾选 → POST；不可用方案勾选后保存，可用时再生效）
    $('prot-save').addEventListener('click', async () => {
      const methods = [];
      document.querySelectorAll('#prot-list input[type=checkbox]').forEach((cb) => {
        if (cb.checked) methods.push(cb.dataset.mid);
      });
      const msg = $('prot-msg');
      msg.textContent = '应用中…';
      msg.className = 'status dim';
      const r = await api('/api/protection', 'POST', { methods });
      if (r.ok) {
        const on = (r.results || []).filter((x) => x.action === 'enable');
        const off = (r.results || []).filter((x) => x.action === 'disable');
        const pending = (r.results || []).filter((x) => x.pending);
        msg.textContent = `✅ 已应用：启用 ${on.length} 项、停用 ${off.length} 项${pending.length ? '、待可用 ' + pending.length + ' 项（可用时自动生效）' : ''}（当前共 ${methods.length} 项）`;
        msg.className = 'status ok';
      } else {
        msg.textContent = '❌ ' + (r.error || '应用失败');
        msg.className = 'status err';
      }
      loadProtection();
    });
    // 救援环境安装器：拉取最新并安装
    $('installer-run').addEventListener('click', async () => {
      const btn = $('installer-run');
      const progress = $('installer-progress');
      const targets = [];
      if ($('installer-target-test').checked) targets.push('test');
      if ($('installer-target-clean').checked) targets.push('clean');
      const msg = $('installer-msg');
      // 禁用按钮 + 显示进度条（防重复点击；长任务给进行中反馈）
      btn.disabled = true;
      progress.classList.add('active');
      msg.textContent = '拉取最新源码并安装中…（可能 1-2 分钟）';
      msg.className = 'status dim';
      try {
        const r = await api('/api/installer/install', 'POST', { targets });
        if (r.ok) {
          const detail = (r.results || []).map((x) => `${x.target}: ${x.ok ? '✅' : '❌ ' + (x.error || '')}`).join(' | ');
          msg.textContent = `✅ 安装完成 v${r.version || '?'} — ${detail}`;
          msg.className = 'status ok';
        } else {
          msg.textContent = '❌ ' + (r.error || '安装失败');
          msg.className = 'status err';
        }
      } catch (e) {
        msg.textContent = '❌ ' + (e?.message || e || '请求异常');
        msg.className = 'status err';
      } finally {
        btn.disabled = false;
        progress.classList.remove('active');
        loadInstaller();
      }
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
      logCleared = true; // 阻止后续自动重绘
      $('log').innerHTML = '<div class="empty">已清空（服务端日志仍在，刷新页面恢复显示）</div>';
    });
    // 2.5.0：手动恢复中断会话（guardian 触发 session-manager scan）
    $('btn-recover-session').addEventListener('click', async () => {
      if (!confirm('恢复中断会话？将调用 session-manager scan 扫描并续跑可恢复的会话（需已装 session-manager）。')) return;
      setMsg('恢复会话中…');
      const r = await api('/api/session-recover', 'POST', { reason: 'guardian-manual' });
      if (r.ok) {
        setMsg(r.skipped ? '⚠️ ' + (r.detail || 'session-manager 未安装，跳过恢复') : '✅ ' + (r.detail || '已触发会话恢复'), r.skipped ? 'warn' : 'ok');
      } else {
        setMsg('❌ ' + (r.detail || r.error || '恢复失败'), 'err');
      }
      loadStatus();
    });
    // 2.5.0：手动关闭自动救援（不杀 guardian，DSH 崩溃只保留现场不 git 回退/拉起）
    $('btn-auto-recover-off').addEventListener('click', async () => {
      if (!confirm('关闭自动救援？DSH 崩溃时将只保留现场+事件，不自动 git 回退/拉起（guardian 进程保持运行）。测试完记得点「开启自动救援」恢复！')) return;
      const r = await api('/api/auto-recover', 'POST', { enabled: false });
      setMsg(r.ok ? '⏸ 自动救援已关闭（DSH 崩溃不再自动回退/拉起）' : '❌ ' + (r.error || '关闭失败'), r.ok ? 'warn' : 'err');
      loadStatus();
    });
    $('btn-auto-recover-on').addEventListener('click', async () => {
      const r = await api('/api/auto-recover', 'POST', { enabled: true });
      setMsg(r.ok ? '▶ 自动救援已开启（DSH 崩溃将自动 git 回退/拉起）' : '❌ ' + (r.error || '开启失败'), r.ok ? 'ok' : 'err');
      loadStatus();
    });
  }

  // ===== 远端备份库面板（P2-2，2026-08-21）=====
  async function loadBackupStatus() {
    const r = await api('/api/backup/status');
    const stEl = $('backup-status');
    const infoEl = $('backup-info');
    if (!r.ok) { stEl.textContent = '读取失败: ' + (r.error || '未知'); stEl.className = 'msg err'; infoEl.style.display = 'none'; return; }
    // 认证方式
    const authParts = [];
    if (r.auth?.method === 'token') authParts.push(`✅ Token 已配置（${r.auth.tokenMasked || ''}）`);
    else authParts.push('⚠️ 未配置认证（无法推送）');
    // 仓库信息
    const repoLink = r.repo ? `[${r.repo}]` : '—';
    authParts.push(`仓名: ${repoLink}`);
    authParts.push(`DSH 版本: ${r.dshVersion}`);
    authParts.push(`设备: ${r.deviceId || '—'}`);
    stEl.textContent = authParts.join(' · ');
    stEl.className = 'msg ' + (r.auth?.method === 'none' ? 'warn' : 'ok');
    // 仓库详情
    if (r.repo) {
      infoEl.style.display = 'flex';
      $('backup-repo').textContent = r.repo;
      const metaParts = [`设备 ${r.deviceId}`];
      if (r.lastPush) {
        metaParts.push(`最近推送: ${r.lastPush.time ? new Date(r.lastPush.time).toLocaleString() : '—'}`);
        metaParts.push(r.lastPush.error ? `❌ ${r.lastPush.error}` : `✅ ${r.lastPush.commit} (${r.lastPush.files} 文件, ${r.lastPush.method})`);
      } else {
        metaParts.push('暂无推送记录');
      }
      $('backup-meta').textContent = metaParts.join(' · ');
    } else {
      infoEl.style.display = 'none';
    }
  }

  function start() {
    bindActions();
    loadStatus();
    loadAuth();
    loadAdminPw();
    loadBackupSelect();
    loadProtection();
    loadInstaller();
    loadGitLog();
    loadLog();
    loadBackupStatus();
    setInterval(() => { loadStatus(); loadLog(); loadBackupStatus(); }, 5000);
    // LLM 对话（内联：日志区底部对话框 + 发送按钮）
    const sendBtn = document.getElementById('llm-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);
    // LLM 模型选择（2026-08-22）
    setupLlmModelSelect();
  }

  // ===== LLM 模型选择（2026-08-22 web 可选模型）=====
  async function setupLlmModelSelect() {
    const sel = document.getElementById('llm-model-select');
    const saveBtn = document.getElementById('btn-save-llm-model');
    const hint = document.getElementById('llm-model-hint');
    if (!sel) return;
    try {
      const m = await api('/api/llm/models', 'GET');
      if (m.ok && Array.isArray(m.models)) {
        sel.innerHTML = '<option value="">默认（resolveModel）</option>' +
          m.models.map((x) => `<option value="${escapeHtml(x.model)}">${escapeHtml(x.label || x.model)}</option>`).join('');
        if (m.current) sel.value = m.current;
      }
      const c = await api('/api/llm/config', 'GET');
      if (c.ok && c.effective) hint.textContent = '当前生效: ' + c.effective + (c.baseURL ? ' · ' + c.baseURL : '');
    } catch (e) {
      hint.textContent = '模型配置加载失败';
    }
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const model = sel.value;
      const r = await api('/api/llm/config', 'POST', { model });
      if (r.ok) {
        hint.textContent = '已保存: ' + (model || '默认') + '（下次调用生效）';
      } else {
        hint.textContent = '❌ 保存失败: ' + (r.error || '');
      }
    });
  }

  // ===== 与日志 LLM 对话（2026-08-21）=====
  async function sendChatMessage() {
    const input = document.getElementById('llm-chat-input');
    const history = document.getElementById('llm-chat-history');
    const question = (input.value || '').trim();
    if (!question) return;
    // 显示对话历史区
    if (history.style.display === 'none') history.style.display = '';
    history.innerHTML += `<div class="chat-user">${escapeHtml(question)}</div>`;
    input.value = '';
    history.scrollTop = history.scrollHeight;
    // 取当前日志作为上下文
    const st = await api('/api/status');
    const logContext = (st.ok && st.log)
      ? st.log.slice(-50).map(e => `[${e.timeLocal || e.time}] ${e.level}: ${e.msg}`).join('\n')
      : '';
    const r = await api('/api/llm-chat', 'POST', { question, logContext });
    if (r.ok) {
      history.innerHTML += `<div class="chat-assistant">${escapeHtml(r.answer || '无回复')}</div>`;
    } else {
      history.innerHTML += `<div class="chat-error">❌ ${escapeHtml(r.error || '请求失败')}</div>`;
    }
    history.scrollTop = history.scrollHeight;
  }

  document.addEventListener('DOMContentLoaded', start);
})();
