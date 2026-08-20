---
name: rescue-env-write-rule
description: 救援恢复权威规则（2026-08-20 固化）：救援环境（测试环境、纯净环境）运行救援/备份/恢复类操作时，禁止写救援环境自己的目录，统一写到主实例目录（任务/数据等）。处理「测试环境做备份恢复」「救援文件写哪」「测试环境 vs 主环境目录」类场景时加载。
whenToUse: 在测试环境/纯净环境（DSH_HOME 含 dsh-test-*）执行备份、恢复、救援、迁移、写恢复文件等操作，需要决定写入目录时。
generatedBy: user-request 2026-08-20（EIGHTfs：救援环境禁止在自己目录写，在主实例写）
---

# 救援恢复权威规则（rescue-env-write-rule）

> 2026-08-20 用户（EIGHTfs）确立。约束所有 AI 所有会话。
> 核心一句话：**救援/备份/恢复操作，测试环境禁止写自己的目录，一律写到主实例目录。**

## 一、硬性规则

| 环境 | 允许写哪 | 禁止写哪 |
|---|---|---|
| **测试环境**（DSH_HOME 含 `dsh-test-*`：dsh-test-home / dsh-test-rc7 / dsh-test-home-clean） | **主实例目录**：`/vol1/@appshare/DeepSeekHarness/任务`、`/vol1/@appshare/DeepSeekHarness/数据`、主环境 `.dsh`（特定操作） | 测试环境自己的目录（自己的 `.dsh`、`sessions`、`workspace` 子目录、备份目录） |
| **纯净环境**（dsh-clean-env 生成） | 同上（主实例目录） | 同上（纯净环境自己的目录） |
| **主实例** | 自己的目录 | — |

## 二、为什么（理由）

1. **测试/纯净环境会被清理重建**（`--force`、崩溃重建），数据写自己目录 = 必丢
2. **主实例持久**，救援/备份/恢复的数据落主实例才有意义（灾难恢复要能找回）
3. **事故教训（2026-08-20 实测）**：测试环境开发插件时，路径写死主环境导致测试验证污染主环境 .dsh（明文 zstd 写坏会话、目录编码错误 → 主实例崩溃）；反之救援文件写测试环境也会随重建丢失——**双向都要规避，统一写主实例目录**

## 三、判定方法（实测命令）

```bash
# 当前是否救援环境（测试/纯净）
echo $DSH_HOME          # 含 dsh-test-* 即救援环境
# 或读进程环境
tr '\0' '\n' < /proc/<pid>/environ | grep DSH_HOME
```

## 四、允许写入的主实例目录速查

| 目录 | 用途 | 示例 |
|---|---|---|
| `/vol1/@appshare/DeepSeekHarness/任务` | 任务清单 md（dsh-tasklist 管理） | 任务清单-*.md |
| `/vol1/@appshare/DeepSeekHarness/数据` | 备份/恢复/日志/临时产物 | 数据/备份/、数据/日志/ |
| `/vol1/@appshare/DeepSeekHarness/.dsh` | 主实例配置/凭据/会话（仅特定救援操作） | workspace.json、sessions/ |

## 五、应用场景

- 测试环境执行备份/恢复/迁移 → 目标目录写主实例 `数据` 或 `任务`
- 测试环境跑插件（路径写死主环境时）→ 确认写的是主实例目录，且格式正确（zstd 多帧、UTF-16BE 目录编码）
- 主环境崩溃抢救 → 任务清单/恢复文件放主实例目录，抢救过程中测试/纯净环境可写（防遗忘、少耽误事）

## 六、配套

- `linkage-skill-convention`：任务清单 md 规范（涉及 git 项目开头、命名、格式）
- `dsh-git-rescue`：救援插件本身（git 回退/守护）
- `zstd-session-log-repair`：会话日志 zstd 帧格式（写主环境会话时必读）
