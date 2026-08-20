---
name: dsh-clean-env
description: DSH 纯测试环境（初始、不含本地插件的干净基线）一键生成脚本 dsh-clean-env.sh 的说明与完整源码。含 create/start/stop/status 用法、生成的文件结构、端口与反代行为。需要干净 DSH 实例做对照/隔离测试、重建或使用 dsh-clean-env.sh、区分"纯环境 vs 定制测试环境"时加载。
whenToUse: 用户要求"纯测试环境"、"干净实例"、"无插件基线"、"初始环境"、需要快速起一个不带任何本地插件的 DSH 实例、需要重建/修改 dsh-clean-env.sh、或不确定测试环境是否干净时。
---

# DSH 纯测试环境快速生成（dsh-clean-env）

> 一键生成并管理「初始、不含本地插件」的 DSH 测试实例。与 `dsh-test-env` 的定制测试环境（加载 whale-musume / test-sync）**互不影响、完全隔离**。脚本丢失时可按文末「完整源码」重建。

## 一、为什么需要纯环境

定制测试环境（`dsh-test-home`）的 `cordis.patch.yml` 已插入本地插件，验证"DSH 基础功能是否正常"、做插件前后对照、或排查是否是插件引起的问题时，需要一份干净基线。纯环境 = 只有官方 `dsh-base` + `dsh-web-app` 两个 bundle：

- 无 node_modules（纯环境没有本地插件要解析，与主实例 profile 结构一致，bundles 从全局安装解析）
- 无 cordis.patch.yml 插件（空 `[]`）
- 无 settings.yaml / .credentials.yaml 预置（首次启动自动生成）
- 无 whale-musume / dsh-test-sync

## 二、用法

```bash
cd /vol1/@appshare/DeepSeekHarness/workspace

./dsh-clean-env.sh start                  # 生成(如缺) + 启动，打印端口；就绪后自检 HTTP 200
./dsh-clean-env.sh start my-env           # 指定环境名（默认 dsh-test-home-clean）
./dsh-clean-env.sh status [环境名]        # 查看运行状态
./dsh-clean-env.sh stop  [环境名]         # 停止（按 .dsh-env-port 记录精准 kill）
./dsh-clean-env.sh create --force         # 目录已存在时重建（先停旧实例）
```

## 三、生成的环境结构

```
workspace/<环境名>/                  （默认 dsh-test-home-clean）
├── profiles/web/
│   ├── cordis.yml                  空 entry list（注释 + []）
│   ├── package.json                name=dsh-profile-web, dependencies={}, bundles=[dsh-base, dsh-web-app]
│   ├── cordis.patch.yml            空 []（需要验证插件时在此 insert）
│   └── pnpm-workspace.yaml         nodeLinker: hoisted
├── sessions/  storages/  skills/   空数据目录
├── .dsh-env-port                   端口记录（stop 用）
└── dsh-env.log                     启动日志
```

## 四、行为细节（踩坑实录）

1. **端口**：自动取 3083-3182 第一个空闲端口，写入 `.dsh-env-port`；`stop` 按端口精准 kill，不会误伤主实例（3081）或其他实例
2. **抗沙箱回收**：启动用 `setsid`（实测 `nohup` 会被执行环境在命令结束时回收，`setsid` 更可靠）；日志在 `dsh-env.log`
3. **局域网访问**：实例绑 127.0.0.1；反代 `dsh-test-proxy.sh` 指向 3083-3182 **第一个被占端口**——若纯环境占了 3083，反代 3084 即指向它（http://10.10.10.121:3084）
4. **就绪自检**：启动后最多等 24s，轮询 HTTP 200 才算就绪（实测完整启动需 8-12 秒）
5. **多个纯环境并存**：环境名是第二参数，各环境目录/端口/日志完全独立
6. **重启**：直接再 `start` 会提示已运行；先 `stop` 再 `start`

## 五、与 dsh-test-env 的关系

| | dsh-clean-env（本 skill） | dsh-test-env |
|---|---|---|
| 环境目录 | workspace/dsh-test-home-clean | workspace/dsh-test-home |
| 插件 | 无（纯基线） | whale-musume + dsh-test-sync |
| 生成方式 | 脚本自动生成 4 个 profile 文件 | 手动定制（继承主实例配置 + 手写 patch） |
| 适用场景 | 基础验证 / 对照基线 / 隔离排查 | 插件热开发 / 双实例调试 |
| node_modules | 不需要 | 需要（镜像目录 + 本地插件软链） |

## 六、完整源码（脚本丢失时重建）

```bash
#!/bin/bash
# dsh-clean-env.sh — 快速生成并管理「初始、不含本地插件」的纯 DSH 测试环境
#
# 纯环境 = 只有 dsh-base + dsh-web-app 两个官方 bundle，无 node_modules、
#          无 cordis.patch.yml 插件、无 settings.yaml，完全初始状态。
#          与 dsh-test-home（已定制加载 whale-musume / test-sync）互不影响。
#
# 用法:
#   ./dsh-clean-env.sh create [环境名] [--force]   生成环境目录（默认 dsh-test-home-clean）
#   ./dsh-clean-env.sh start  [环境名]             生成(如缺) + 启动，打印访问地址
#   ./dsh-clean-env.sh stop   [环境名]             停止
#   ./dsh-clean-env.sh status [环境名]             查看状态
#
# 局域网访问: 实例绑 127.0.0.1，需要时用 dsh-test-proxy.sh 做反代
set -euo pipefail

WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="/vol1/@appcenter/deepseek-harness"
NODE_BIN="${APP_DIR}/bin/node"
DSH_BIN="${APP_DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js"
NAME="${2:-dsh-test-home-clean}"
ENV_DIR="${WORKSPACE}/${NAME}"
PORT_FILE="${ENV_DIR}/.dsh-env-port"

find_free_port() {
    for port in $(seq 3083 3182); do
        if ! ss -tln 2>/dev/null | grep -q ":${port} "; then
            echo "$port"
            return 0
        fi
    done
    echo "0"
}

env_running() {
    local port="${1:-}"
    [ -n "$port" ] && pgrep -f "bin\.js web .*--port ${port}" >/dev/null 2>&1
}

create_env() {
    local force="${1:-}"
    if [ -d "$ENV_DIR" ]; then
        if [ "$force" = "--force" ]; then
            echo "[create] 目录已存在，--force 重建: $ENV_DIR"
            stop_env || true
            rm -rf "$ENV_DIR"
        else
            echo "[create] 目录已存在（跳过，--force 可重建）: $ENV_DIR"
            return 0
        fi
    fi
    mkdir -p "${ENV_DIR}/profiles/web" "${ENV_DIR}/sessions" "${ENV_DIR}/storages" "${ENV_DIR}/skills"

    cat > "${ENV_DIR}/profiles/web/cordis.yml" <<'EOF'
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
EOF

    cat > "${ENV_DIR}/profiles/web/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
EOF

    cat > "${ENV_DIR}/profiles/web/cordis.patch.yml" <<'EOF'
# 纯测试环境：不加载任何本地插件。
# 需要验证某个插件时，在此 insert（并把它链接进 node_modules 才可解析）。
[]
EOF

    cat > "${ENV_DIR}/profiles/web/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF

    echo "[create] ✅ 纯测试环境已生成: $ENV_DIR"
    echo "         profiles/web: cordis.yml / package.json / cordis.patch.yml / pnpm-workspace.yaml"
    echo "         （无 node_modules、无本地插件、无 settings.yaml，完全初始状态）"
}

start_env() {
    create_env ""
    local port=""
    [ -f "$PORT_FILE" ] && port=$(cat "$PORT_FILE")
    if env_running "$port"; then
        echo "[start] 已运行: http://127.0.0.1:${port} （如需重启先 stop）"
        return 0
    fi
    port=$(find_free_port)
    [ "$port" = "0" ] && { echo "[start] 错误: 3083-3182 无空闲端口"; exit 1; }
    echo "$port" > "$PORT_FILE"
    echo "[start] 启动纯测试实例: DSH_HOME=${ENV_DIR} port=${port}"
    setsid env \
        DSH_HOME="$ENV_DIR" \
        HOME="/vol1/@appshare/DeepSeekHarness" \
        PATH="${APP_DIR}/bin:${PATH}" \
        "$NODE_BIN" "$DSH_BIN" web --host 127.0.0.1 --port "$port" \
        > "${ENV_DIR}/dsh-env.log" 2>&1 < /dev/null &
    echo "[start] 日志: ${ENV_DIR}/dsh-env.log"
    echo "[start] 等待启动 (最长 24s)..."
    for _ in $(seq 1 24); do
        if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${port}/" 2>/dev/null; then
            echo "[start] ✅ 就绪: http://127.0.0.1:${port}"
            echo "[start] 局域网访问: 需反代，参考 dsh-test-proxy.sh"
            return 0
        fi
        sleep 1
    done
    echo "[start] ⚠️ 启动超时，检查日志: ${ENV_DIR}/dsh-env.log"
    exit 1
}

stop_env() {
    local port=""
    [ -f "$PORT_FILE" ] && port=$(cat "$PORT_FILE")
    if env_running "$port"; then
        local pids
        pids=$(pgrep -f "bin\.js web .*--port ${port}" | tr '\n' ' ')
        echo "[stop] 停止实例 (port ${port}, pid: ${pids})"
        # shellcheck disable=SC2086
        kill $pids 2>/dev/null || true
        sleep 2
        if env_running "$port"; then
            # shellcheck disable=SC2086
            pids=$(pgrep -f "bin\.js web .*--port ${port}" | tr '\n' ' ')
            kill -9 $pids 2>/dev/null || true
        fi
        echo "[stop] ✅ 已停止"
    else
        echo "[stop] 未在运行"
    fi
}

status_env() {
    local port=""
    [ -f "$PORT_FILE" ] && port=$(cat "$PORT_FILE")
    if env_running "$port"; then
        echo "[status] ✅ 运行中: http://127.0.0.1:${port}  (DSH_HOME=${ENV_DIR})"
    else
        echo "[status] 未运行  (DSH_HOME=${ENV_DIR})"
    fi
}

case "${1:-help}" in
    create) create_env "${3:-}" ;;
    start)  start_env ;;
    stop)   stop_env ;;
    status) status_env ;;
    *)
        cat <<'EOF'
用法: ./dsh-clean-env.sh <create|start|stop|status> [环境名]

  环境名     默认 dsh-test-home-clean，生成于 workspace 下（与 dsh-test-home 完全隔离）
  create --force   目录已存在时重建（会先停旧实例）
EOF
        ;;
esac
```
