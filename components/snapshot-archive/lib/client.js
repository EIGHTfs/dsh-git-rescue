/**
 * dsh-snapshot-archive — 客户端
 *
 * 撤销/恢复/快照管理按钮放在【设置 → 插件配置】卡片里（settings.plugin.item slot），
 * 不在顶部 header。零依赖：直接 fetch /api/snapshot-archive/*。
 */

window.__ModuleLoader__.load({
  id: "dsh-snapshot-archive",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    //#region 样式
    const css = `
      .sa_card { display:flex; flex-direction:column; gap:10px; }
      .sa_row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .sa_btn { cursor:pointer; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); background:var(--dsw-specific-tip, transparent); color:var(--dsw-alias-label-secondary, inherit); border-radius:8px; height:28px; padding:0 12px; font-size:12px; line-height:26px; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
      .sa_btn:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); color:var(--dsw-alias-label-primary, inherit); }
      .sa_btn:disabled { opacity:.45; cursor:default; }
      .sa_msg { font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary, #888); }
      .sa_msg.ok { color:var(--dsw-alias-label-secondary, inherit); }
      .sa_msg.err { color:var(--dsw-state-error-primary, #d9534f); }
      .sa_list { display:flex; flex-direction:column; gap:4px; max-height:280px; overflow-y:auto; }
      .sa_item { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; font-size:12px; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); }
      .sa_item:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
      .sa_item .sa_id { font-family:monospace; color:var(--dsw-alias-label-secondary, inherit); flex:none; }
      .sa_item .sa_meta { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-tertiary, #888); }
      .sa_item .sa_ops { display:flex; gap:4px; flex:none; }
      .sa_item button { cursor:pointer; border:none; background:transparent; color:var(--dsw-alias-label-secondary, inherit); font-size:11px; padding:2px 6px; border-radius:5px; }
      .sa_item button:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); }
      .sa_item button.sa_go { color:#30a46c; }
      .sa_item button.sa_del { color:#e5484d; }
      .sa_empty { color:var(--dsw-alias-label-tertiary, #888); text-align:center; padding:16px 0; font-size:12px; }
      .sa_hint { color:var(--dsw-alias-label-tertiary, #888); font-size:11px; line-height:16px; }
      .sa_root { color:var(--dsw-alias-label-tertiary, #888); font-size:11px; font-family:monospace; }
    `;
    const styleId = "dsh-snapshot-archive-css";
    if (typeof document !== "undefined" && !document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = css;
      document.head.appendChild(s);
    }
    //#endregion

    //#region 语言包
    const NS = "snapshotArchive";
    const zh = {
      title: "快照归档",
      desc: "把 .dsh 配置按原始目录结构打包成 zip；恢复 = 从列表选一个快照解压回 .dsh。",
      create: "📸 创建快照",
      refresh: "刷新",
      list: "快照列表",
      empty: "暂无快照。点「创建快照」立即存档当前配置。",
      created: "已创建快照 {id}（{n} 个文件）",
      restored: "已恢复到 {id}",
      removed: "已删除 {id}",
      error: "操作失败: {msg}",
      confirmRestore: "恢复到该快照？当前配置会被快照内容覆盖。",
      confirmDelete: "删除该快照？不可恢复。",
      hint: "恢复 = 解压 zip 到 ~/.dsh 根目录。敏感文件（如 .credentials.yaml）本机恢复时保留现有真实值。",
    };
    const en = {
      title: "Snapshot Archive",
      desc: "Package .dsh config into zip with original tree; restore by picking a snapshot.",
      create: "📸 Create snapshot",
      refresh: "Refresh",
      list: "Snapshots",
      empty: "No snapshots yet. Click Create to archive the current config.",
      created: "Snapshot created {id} ({n} files)",
      restored: "Restored → {id}",
      removed: "Removed {id}",
      error: "Failed: {msg}",
      confirmRestore: "Restore to this snapshot? Current config will be overwritten.",
      confirmDelete: "Delete this snapshot? Cannot be undone.",
      hint: "Restore = unzip to ~/.dsh root. Sensitive files (.credentials.yaml) keep existing real values on local restore.",
    };
    //#endregion

    function fmt(tpl, vars) {
      return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? vars[k] : ""));
    }

    function api(path, method, body) {
      return fetch(path, {
        method: method || "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: { message: String((e && e.message) || e) } }));
    }

    /** 恢复后配置变了，刷新页面让 UI 重新读取。 */
    function maybeReload(r) {
      if (r && r.ok && !r.nothing) {
        setTimeout(() => { try { location.reload(); } catch (e) { /* noop */ } }, 350);
      }
    }

    //#region 主组件
    function SnapshotArchiveCard({ t }) {
      const [snapshots, setSnapshots] = react.useState([]);
      const [status, setStatus] = react.useState(null);
      const [msg, setMsg] = react.useState(null);
      const [busy, setBusy] = react.useState(false);

      const load = react.useCallback(async () => {
        const [l, st] = await Promise.all([
          api("/api/snapshot-archive/list"),
          api("/api/snapshot-archive/status"),
        ]);
        if (l.ok) setSnapshots(l.snapshots || []);
        if (st.ok) setStatus(st);
      }, []);

      react.useEffect(() => { load(); }, [load]);

      const createSnap = async () => {
        setBusy(true);
        setMsg(null);
        const r = await api("/api/snapshot-archive/snapshot", "POST", { reason: "manual" });
        setBusy(false);
        if (r.ok) {
          setMsg({ kind: "ok", text: fmt(t("created"), { id: r.id, n: r.files }) });
          load();
        } else {
          setMsg({ kind: "err", text: fmt(t("error"), { msg: r.error?.message || "" }) });
        }
      };

      const restoreSnap = async (id) => {
        if (!window.confirm(t("confirmRestore"))) return;
        setBusy(true);
        setMsg(null);
        const r = await api("/api/snapshot-archive/restore", "POST", { id });
        setBusy(false);
        if (r.ok) {
          setMsg({ kind: "ok", text: fmt(t("restored"), { id }) });
          maybeReload(r);
          load();
        } else {
          setMsg({ kind: "err", text: fmt(t("error"), { msg: r.error?.message || "" }) });
        }
      };
      const removeSnap = async (id) => {
        if (!window.confirm(t("confirmDelete"))) return;
        const r = await api("/api/snapshot-archive/remove", "POST", { id });
        if (r.ok) {
          setMsg({ kind: "ok", text: fmt(t("removed"), { id }) });
          load();
        }
      };

      return react_jsx_runtime.jsxs("div", { className: "sa_card", children: [
        react_jsx_runtime.jsx("div", { className: "sa_row", children: [
          react_jsx_runtime.jsx("button", { className: "sa_btn", disabled: busy, onClick: createSnap, children: t("create") }),
          react_jsx_runtime.jsx("button", { className: "sa_btn", disabled: busy, onClick: load, children: t("refresh") }),
        ] }),
        msg && react_jsx_runtime.jsx("div", { className: "sa_msg " + msg.kind, children: msg.text }),
        react_jsx_runtime.jsx("div", { className: "sa_row", children: [
          react_jsx_runtime.jsx("span", { className: "sa_root", children: status ? "~/.dsh · " + status.profile + " · " + status.count + " 快照" : "" }),
        ] }),
        react_jsx_runtime.jsx("div", { className: "sa_list", children: snapshots.length === 0
          ? react_jsx_runtime.jsx("div", { className: "sa_empty", children: t("empty") })
          : snapshots.map((s) => react_jsx_runtime.jsxs("div", { className: "sa_item", key: s.id, children: [
              react_jsx_runtime.jsx("span", { className: "sa_id", children: s.id }),
              react_jsx_runtime.jsx("span", { className: "sa_meta", children: s.time + " · " + (s.reason || "") + " · " + s.fileCount + " 文件" }),
              react_jsx_runtime.jsx("span", { className: "sa_ops", children: [
                react_jsx_runtime.jsx("button", { className: "sa_go", onClick: () => restoreSnap(s.id), children: t("restored") }),
                react_jsx_runtime.jsx("button", { className: "sa_del", onClick: () => removeSnap(s.id), children: "✕" }),
              ] }),
            ] })) }),
        react_jsx_runtime.jsx("div", { className: "sa_hint", children: t("hint") }),
      ] });
    }
    //#endregion

    //#region 插件入口
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-snapshot-archive: dictionaries");
      // 按钮放在 设置 → 插件配置 卡片里，不注册顶部 header slot
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        id: "dsh-snapshot-archive",
        order: 40,
        locale: NS,
      }, function WrappedCard(props) {
        const t = ctx.locale.bind(NS);
        return react_jsx_runtime.jsxs("div", { children: [
          react_jsx_runtime.jsx("div", { children: t("title") }),
          react_jsx_runtime.jsx("div", { className: "sa_hint", children: t("desc") }),
          react_jsx_runtime.jsx(SnapshotArchiveCard, { t }),
        ] });
      }));
    }
    //#endregion

    const inject = ["slots", "locale"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
