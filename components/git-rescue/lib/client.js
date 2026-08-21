// dsh-test-env-entry —— 测试环境入口（浏览器半边）。
//
// 侧边栏底部（设置上方）新增「测试环境」入口，点击展开浮层面板：
//   · 主实例 / 测试实例 / 纯环境 三张状态卡：端口、运行状态徽标、可点击打开链接
//   · 底部操作：打开另一个环境（正式⇄测试互相跳转）/ 启动测试环境 / 停止测试环境
// 当前所在环境通过 location.port 判断（3080/3081=正式，3083-3182/3084=测试），
// 「打开测试实例」在自己身上时自动变成「打开正式环境」，实现双向互跳。
// 数据源为宿主路由 /api/dsh-test-env/status（打开面板时自动刷新）。
// 纯内联样式 + 主题 CSS 变量（--dsw-*），不依赖任何哈希类名。

window.__ModuleLoader__.load({
  id: "dsh-git-rescue",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // ---------- 样式（主题变量 + 兜底色，与 session-manager 同风格） ----------
    const S = {
      trigger: (wide) => ({
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: wide ? "6px 10px" : "6px",
        margin: "0 6px 6px",
        borderRadius: 8,
        border: "1px solid transparent",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, #9a9aa0)",
        fontSize: 12,
        lineHeight: 1.4,
        cursor: "pointer",
        whiteSpace: "nowrap",
        textAlign: "left",
        width: wide ? "auto" : 32,
        justifyContent: wide ? "flex-start" : "center",
      }),
      overlay: { position: "fixed", inset: 0, zIndex: 9999 },
      backdrop: { position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)" },
      panel: {
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 420,
        maxWidth: "94vw",
        background: "var(--dsw-alias-bg-layer-2, #202024)",
        color: "var(--dsw-alias-label-primary, #ececf0)",
        boxShadow: "-10px 0 32px rgba(0,0,0,0.4)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        fontSize: 13,
      },
      header: {
        padding: "14px 16px 10px",
        borderBottom: "1px solid var(--dsw-alias-interactive-bg-hover, #333338)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 8,
      },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      subtitle: { margin: "3px 0 0", fontSize: 12, color: "var(--dsw-alias-label-secondary, #9a9aa0)" },
      close: {
        background: "transparent",
        border: "none",
        color: "var(--dsw-alias-label-secondary, #9a9aa0)",
        fontSize: 16,
        lineHeight: 1,
        cursor: "pointer",
        padding: "2px 6px",
        borderRadius: 6,
      },
      body: { flex: 1, overflowY: "auto", padding: "10px 14px 16px" },
      card: {
        borderRadius: 10,
        border: "1px solid var(--dsw-alias-interactive-bg-hover, #2e2e33)",
        background: "var(--dsw-alias-bg-layer-1, #18181c)",
        padding: "10px 12px",
        marginTop: 8,
      },
      cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
      cardName: { fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 },
      badge: (running) => ({
        flexShrink: 0,
        fontSize: 10.5,
        padding: "1px 7px",
        borderRadius: 999,
        border: "1px solid",
        ...(running
          ? { color: "var(--dsw-state-success-primary, #4caf7d)", borderColor: "currentColor" }
          : { color: "var(--dsw-alias-label-tertiary, #77777d)", borderColor: "currentColor" }),
      }),
      cardMeta: { marginTop: 6, fontSize: 11.5, color: "var(--dsw-alias-label-secondary, #9a9aa0)", lineHeight: 1.6 },
      link: {
        color: "var(--dsw-alias-interactive-fg, #6ea8fe)",
        cursor: "pointer",
        textDecoration: "underline",
        wordBreak: "break-all",
      },
      actions: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" },
      actionBtn: (danger) => ({
        background: "transparent",
        border: danger ? "1px solid var(--dsw-state-error-primary, #d9534f)" : "1px solid var(--dsw-alias-interactive-bg-hover, #3a3a40)",
        color: danger ? "var(--dsw-state-error-primary, #d9534f)" : "var(--dsw-alias-label-secondary, #d0d0d6)",
        borderRadius: 6,
        padding: "5px 12px",
        fontSize: 12,
        cursor: "pointer",
        flex: 1,
        minWidth: 96,
      }),
      hint: { margin: "12px 0 0", fontSize: 11.5, color: "var(--dsw-alias-label-tertiary, #77777d)", lineHeight: 1.6 },
      error: { marginTop: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-state-error-primary, #d9534f)", color: "var(--dsw-state-error-primary, #d9534f)", fontSize: 12 },
      empty: { marginTop: 24, textAlign: "center", color: "var(--dsw-alias-label-tertiary, #77777d)", fontSize: 12.5 },
      refreshRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 },
      refreshBtn: {
        background: "transparent",
        border: "1px solid var(--dsw-alias-interactive-bg-hover, #3a3a40)",
        color: "var(--dsw-alias-label-secondary, #d0d0d6)",
        borderRadius: 6,
        padding: "3px 10px",
        fontSize: 11.5,
        cursor: "pointer",
      },
      ts: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #77777d)" },
    };

    // ---------- 组件 ----------
    function TestEnvPanel({ wide }) {
      const [open, setOpen] = react.useState(false);
      const [status, setStatus] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);

      const refresh = react.useCallback(async () => {
        try {
          const res = await fetch("/api/dsh-test-env/status");
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? "status failed");
          setStatus(body);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      react.useEffect(() => {
        if (open) refresh();
      }, [open, refresh]);

      const act = react.useCallback(async (action, confirmText) => {
        if (busy) return;
        if (confirmText && !window.confirm(confirmText)) return;
        setBusy(true);
        try {
          const res = await fetch(`/api/dsh-test-env/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error?.message ?? "action failed");
          window.alert(body.message ?? "已执行");
          // 启停会重启/断开当前实例：稍等片刻后尝试刷新；若实例已重启，页面重连后再刷
          setTimeout(() => {
            setBusy(false);
            refresh();
          }, 6000);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          window.alert(`操作失败：${message}`);
          setBusy(false);
        }
      }, [busy, refresh]);

      const openLink = (url) => {
        if (url) window.open(url, "_blank", "noopener");
      };

      // ---------- 当前环境检测（正式 ⇄ 测试互相跳转） ----------
      // 3080/3081 = 正式环境（主实例）；3083-3182（含反代 3084）= 测试环境
      const currentPort = Number(window.location.port || (window.location.protocol === "https:" ? 443 : 80));
      const isTestEnv = currentPort >= 3083 && currentPort <= 3182;
      // 默认假设：插件的宿主（status.main.url 指向正式）用于判断目标
      const targetMain = status?.main?.url ?? "http://10.10.10.121:3080";
      const targetTest = status?.test?.url ?? "http://10.10.10.121:3084";
      // 在测试实例上看不到「打开测试实例」（跳自己）→ 改为「打开正式环境」；反之亦然
      const swapBtn =
        isTestEnv
          ? { label: "打开正式环境", url: targetMain, icon: "🏠" }
          : { label: "打开测试环境", url: targetTest, icon: "🧪" };

      const renderCard = (name, icon, info, key, current) => {
        const running = info.running === true;
        return (0, react_jsx_runtime.jsx)("div", {
          style: { ...S.card, ...(current ? { border: "1px solid var(--dsw-alias-interactive-fg, #6ea8fe)" } : {}) },
          children: [
            (0, react_jsx_runtime.jsxs)("div", {
              style: S.cardHead,
              children: [
                (0, react_jsx_runtime.jsxs)("span", {
                  style: S.cardName,
                  children: [icon, " ", name, current ? " (当前)" : ""],
                }),
                (0, react_jsx_runtime.jsx)("span", {
                  style: S.badge(running),
                  children: running ? "运行中" : "已停止",
                }),
              ],
            }),
            (0, react_jsx_runtime.jsx)("div", {
              style: S.cardMeta,
              children: [
                `端口 ${info.port ?? "—"}`,
                info.directPort && info.directPort !== info.port ? ` · 直达 ${info.directPort}` : "",
                info.extra ? ` · ${info.extra}` : "",
              ].join(""),
            }),
            info.url !== null && info.url !== void 0 && (0, react_jsx_runtime.jsx)("div", {
              style: { ...S.cardMeta, marginTop: 2 },
              children: (0, react_jsx_runtime.jsx)("a", {
                style: S.link,
                href: info.url,
                onClick: (event) => { event.preventDefault(); openLink(info.url); },
                children: info.url,
              }),
            }),
          ],
        });
      };

      return (0, react_jsx_runtime.jsxs)(react.Fragment, {
        children: [
          (0, react_jsx_runtime.jsx)("button", {
            title: "测试环境入口：查看/启停测试实例",
            "aria-label": "测试环境入口",
            onClick: () => setOpen(true),
            style: S.trigger(wide),
            children: wide ? "测试环境" : "🧪",
          }),
          open &&
            (0, react_jsx_runtime.jsxs)("div", {
              style: S.overlay,
              children: [
                (0, react_jsx_runtime.jsx)("div", {
                  style: S.backdrop,
                  onClick: () => setOpen(false),
                }),
                (0, react_jsx_runtime.jsxs)("div", {
                  style: S.panel,
                  children: [
                    (0, react_jsx_runtime.jsxs)("div", {
                      style: S.header,
                      children: [
                        (0, react_jsx_runtime.jsxs)("div", {
                          children: [
                            (0, react_jsx_runtime.jsx)("h2", { style: S.title, children: "测试环境" }),
                            (0, react_jsx_runtime.jsx)("p", { style: S.subtitle, children: "主实例 · 测试实例 · 反代状态" }),
                          ],
                        }),
                        (0, react_jsx_runtime.jsx)("button", {
                          style: S.close,
                          "aria-label": "close",
                          onClick: () => setOpen(false),
                          children: "✕",
                        }),
                      ],
                    }),
                    (0, react_jsx_runtime.jsx)("div", {
                      style: S.body,
                      children: [
                        error !== null &&
                          (0, react_jsx_runtime.jsxs)("div", {
                            style: S.error,
                            children: [
                              `状态读取失败：${error}`,
                              " ",
                              (0, react_jsx_runtime.jsx)("button", {
                                style: { ...S.refreshBtn, marginLeft: 6 },
                                onClick: refresh,
                                children: "重试",
                              }),
                            ],
                          }),
                        status === null && error === null
                          ? (0, react_jsx_runtime.jsx)("div", { style: S.empty, children: "读取中…" })
                          : status !== null &&
                            (0, react_jsx_runtime.jsxs)(react.Fragment, {
                              children: [
                                renderCard("主实例", "🏠", {
                                  running: status.main.running,
                                  port: status.main.port,
                                  url: status.main.url,
                                  extra: status.main.proxyRunning ? `反代 ${status.main.proxyPort} 正常` : `反代 ${status.main.proxyPort} 未运行`,
                                }, null, !isTestEnv),
                                renderCard("测试实例", "🧪", {
                                  running: status.test.running,
                                  port: status.test.primaryPort ?? "—",
                                  extra: status.test.ports.length > 1 ? `并存 ${status.test.ports.join("/")}` : null,
                                  url: status.test.url,
                                }, null, isTestEnv),
                                renderCard("纯环境", "🌱", {
                                  running: status.clean.running,
                                  port: status.clean.port ?? "未创建",
                                  url: status.clean.url,
                                }),
                                (0, react_jsx_runtime.jsxs)("div", {
                                  style: S.actions,
                                  children: [
                                    (0, react_jsx_runtime.jsx)("button", {
                                      style: S.actionBtn(false),
                                      disabled: busy || !swapBtn.url,
                                      title: isTestEnv ? "跳转到正式环境（主实例）" : "跳转到测试环境",
                                      onClick: () => openLink(swapBtn.url),
                                      children: `${swapBtn.icon} ${swapBtn.label}`,
                                    }),
                                    (0, react_jsx_runtime.jsx)("button", {
                                      style: S.actionBtn(false),
                                      disabled: busy,
                                      onClick: () => act("start", "确定重启测试环境吗？\n\n会先停止旧实例与反代，再重新拉起（页面会断开后重连）。"),
                                      children: busy ? "执行中…" : "启动测试环境",
                                    }),
                                    (0, react_jsx_runtime.jsx)("button", {
                                      style: S.actionBtn(true),
                                      disabled: busy,
                                      onClick: () => act("stop", "确定停止测试实例与反代吗？\n\n当前测试实例页面会断开。"),
                                      children: busy ? "执行中…" : "停止测试环境",
                                    }),
                                  ],
                                }),
                                (0, react_jsx_runtime.jsxs)("div", {
                                  style: S.refreshRow,
                                  children: [
                                    (0, react_jsx_runtime.jsx)("span", {
                                      style: S.ts,
                                      children: status.now ? `更新于 ${new Date(status.now).toLocaleTimeString()}` : "",
                                    }),
                                    (0, react_jsx_runtime.jsx)("button", {
                                      style: S.refreshBtn,
                                      onClick: refresh,
                                      children: "刷新",
                                    }),
                                  ],
                                }),
                                (0, react_jsx_runtime.jsx)("p", {
                                  style: S.hint,
                                  children: "测试实例 = 插件热开发专用（与主实例完全隔离）；纯环境 = dsh-clean-env 干净基线。启动/停止操作在后台执行，当前页面会断开。",
                                }),
                              ],
                            }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
        ],
      });
    }

    // ---------- 插件入口 ----------
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-git-rescue",
        order: 150,
      }, TestEnvPanel));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
