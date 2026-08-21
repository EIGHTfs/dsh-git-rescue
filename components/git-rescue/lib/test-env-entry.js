/**
 * dsh-test-env-entry —— 测试环境入口（宿主半边）
 *
 * 提供「测试环境」面板的数据与操作 API：
 *   GET  /api/dsh-test-env/status   — 探测主实例/测试实例/反代端口状态、可访问 URL
 *   POST /api/dsh-test-env/start    — 一键启动测试实例 + 反代（detached，先停后起）
 *   POST /api/dsh-test-env/stop     — 停止测试实例 + 反代（detached）
 *
 * 端口约定（dsh-test-env skill）：
 *   主实例 3081（反代 3080）/ 测试实例 3083-3182（反代 3084）/ 纯环境 3083-3182 空闲端口。
 * 探测一律走 ss -tln（脚本同款），start/stop 用 setsid + detached 防沙箱回收。
 * ⚠️ 本插件装在测试实例上：stop/start 会杀掉自己所在的实例，属预期行为。
 */
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

// 已整合进 dsh-git-rescue（原 dsh-test-env-entry）
export const inject = ['webServer'];

const Config = z.object({
  /** workspace 根目录（脚本所在地） */
  workspaceDir: z.string().default('/vol1/@appshare/DeepSeekHarness/workspace'),
  /** 主实例端口 */
  mainPort: z.number().default(3081),
  /** 主实例反代端口 */
  mainProxyPort: z.number().default(3080),
  /** 测试实例端口扫描范围 */
  testPortStart: z.number().default(3083),
  testPortEnd: z.number().default(3182),
  /** 测试实例反代端口 */
  testProxyPort: z.number().default(3084),
  /** 局域网入口（访问地址前缀）——⚠️ 禁止硬编码旧机器地址（host-address-convention）：本机为 10.10.10.4，旧机 10.10.10.121 已下线 */
  lanUrl: z.string().default('http://10.10.10.4'),
  enabled: z.boolean().default(true),
});

/** 读一次 ss -tln 输出，返回所有监听端口集合 */
function listeningPorts() {
  return new Promise((resolve) => {
    execFile('ss', ['-tln'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(new Set());
      const ports = new Set();
      for (const match of stdout.matchAll(/:(\d+)\s/g)) {
        ports.add(Number(match[1]));
      }
      resolve(ports);
    });
  });
}

/**
 * 路径判断是否为测试环境（v1.10.0，替代端口范围判断）：
 * DSH_HOME 路径含 `dsh-test-home`（或 `dsh-test-` 前缀目录）即测试环境；
 * 主实例 /vol1/@appshare/DeepSeekHarness/.dsh 不含 → 正式环境。
 * 为什么不用端口：测试实例端口自动分配（3083-3182），残留实例也可能落在范围内，
 * 端口会撞会漂移；DSH_HOME 是实例启动时确定的稳定路径，判断更可靠。
 */
export function isTestHomePath(dshHome) {
  if (!dshHome) return null;
  const norm = String(dshHome).replace(/\\/g, '/');
  return /(^|\/)dsh-test-(home|rc7|clean)(\/|$)/.test(norm);
}

export async function registerTestEnvEntry(ctx, config = {}) {
  const cfg = Config(config);
  if (cfg.enabled === false) {
    console.log('[test-env-entry] 已禁用');
    return;
  }

  const scripts = {
    start: join(cfg.workspaceDir, 'dsh-test-start.sh'),
    stop: join(cfg.workspaceDir, 'dsh-test-instance-stop.sh'),
    instance: join(cfg.workspaceDir, 'dsh-test-instance.sh'),
    proxy: join(cfg.workspaceDir, 'dsh-test-proxy.sh'),
    control: join(cfg.workspaceDir, 'dsh-test-env-entry', 'control.sh'),
  };

  /** detached 执行一段 shell（setsid 脱离会话，防沙箱回收；父进程退出不带走） */
  function runDetached(shellCode) {
    const child = spawn('setsid', ['bash', '-c', shellCode], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: process.env.PATH },
    });
    child.unref();
    return child.pid;
  }

  /** detached 执行 control.sh（start/stop），避免命令行含脚本字面量导致 pkill 自匹配 */
  function runControl(action, port) {
    const child = spawn('setsid', ['bash', '-c', `bash '${scripts.control}' ${action} ${port ?? ''}`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: process.env.PATH },
    });
    child.unref();
    return child.pid;
  }

  /** 精确找监听指定端口的 dsh web 进程 PID（按命令行 --port 匹配，不误杀其他实例） */
  function findPidByPort(port) {
    return new Promise((resolve) => {
      execFile('ps', ['-eo', 'pid,args'], { timeout: 3000 }, (error, stdout) => {
        if (error) return resolve(null);
        for (const line of String(stdout).split('\n')) {
          if (line.includes('bin.js web') && line.includes(`--port ${port}`)) {
            const pid = Number(line.trim().split(/\s+/)[0]);
            if (Number.isInteger(pid) && pid > 0) return resolve(pid);
          }
        }
        resolve(null);
      });
    });
  }

  async function status() {
    const ports = await listeningPorts();
    const mainUp = ports.has(cfg.mainPort);
    const mainProxyUp = ports.has(cfg.mainProxyPort);
    const testProxyUp = ports.has(cfg.testProxyPort);

    // 测试实例：扫描范围内全部监听端口（3083/3085 并存时全部列出），排除反代端口
    const testPorts = [];
    for (let p = cfg.testPortStart; p <= cfg.testPortEnd; p++) {
      if (ports.has(p) && p !== cfg.testProxyPort) testPorts.push(p);
    }
    const primaryTestPort = testPorts[0] ?? null;

    // 当前实例自我识别（v1.10.0）：路径判断测试环境（DSH_HOME 含 dsh-test-*），替代端口范围
    const selfHome = process.env.DSH_HOME || '';

    return {
      ok: true,
      now: new Date().toISOString(),
      self: {
        dshHome: selfHome,
        isTest: isTestHomePath(selfHome),
      },
      main: {
        port: cfg.mainPort,
        proxyPort: cfg.mainProxyPort,
        running: mainUp,
        proxyRunning: mainProxyUp,
        url: `${cfg.lanUrl}:${cfg.mainProxyPort}`,
      },
      test: {
        ports: testPorts,
        primaryPort: primaryTestPort,
        proxyPort: cfg.testProxyPort,
        running: testPorts.length > 0,
        proxyRunning: testProxyUp,
        url: `${cfg.lanUrl}:${cfg.testProxyPort}`,
      },
      scripts,
      note: '测试实例 = 插件热开发专用；主实例 3081 只读不可装插件。',
    };
  }

  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer');
    if (!webServer) return;
    wctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/dsh-test-env',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local');
          const p = url.pathname;
          const m = req.method ?? 'GET';

          if (p === '/api/dsh-test-env/status' && m === 'GET') {
            return json(res, 200, await status());
          }
          if (p === '/api/dsh-test-env/stop' && m === 'POST') {
            // 当前实例端口：优先取本插件所在实例（TEST_DSH_PORT），否则取扫描到的最小端口
            const target = Number(process.env.TEST_DSH_PORT) || (await status()).test.primaryPort;
            if (!target) {
              return json(res, 404, { ok: false, error: '未找到测试实例端口，无法停止。' });
            }
            const pid = await findPidByPort(target);
            if (!pid) {
              return json(res, 404, { ok: false, error: `端口 ${target} 未找到运行中的实例，可能已停止。` });
            }
            // detached 延迟执行：先返回响应，再经 control.sh 精确按端口杀实例 + 停反代
            const spid = runControl('stop', target);
            return json(res, 200, { ok: true, message: `已提交停止命令：测试实例(端口 ${target})与反代即将停止，当前页面会断开。`, pid: spid });
          }
          if (p === '/api/dsh-test-env/start' && m === 'POST') {
            // 重启 = 精确停当前实例 → 起新实例（dsh-test-instance.sh 自动取 3083-3182 空闲端口）
            // → 起反代（dsh-test-proxy.sh 自动取目标端口+1 = 3084）。全部 detached，走 control.sh。
            const target = Number(process.env.TEST_DSH_PORT) || (await status()).test.primaryPort;
            const spid = runControl('start', target || '');
            return json(res, 200, { ok: true, message: '已提交启动命令：测试实例将在数秒内重启（页面会断开后重连）。', pid: spid });
          }
          return undefined; // 非本插件路由 → 放行给其他 handler
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      },
    }));
  });

  console.log('[test-env-entry] 已启动 (workspaceDir=' + cfg.workspaceDir + ')');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

export { Config };
