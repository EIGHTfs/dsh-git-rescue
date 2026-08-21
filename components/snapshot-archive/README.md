# dsh-snapshot-archive

DSH 快照归档插件：把 `.dsh` 配置按**原始目录结构**打包成 zip，从列表选一个快照即可恢复。

> 独立自研插件。快照 = zip 压缩包（零依赖生成，跨平台），zip 内路径即 `.dsh` 相对路径，
> 恢复 = 解压到 `~/.dsh` 根目录。

## 特性

- 📦 **zip 快照**：零依赖 store 模式 zip 生成（Linux/macOS/Windows 通用，不经 PowerShell/系统命令）
- 🗂️ **原始目录结构**：zip 内保留 `.dsh` 相对路径（`profiles/web/cordis.patch.yml`、`settings.yaml` 等）
- 🔄 **恢复 = 解压**：从快照列表选一个，解压覆盖到 `~/.dsh`；跨平台恢复脚本（`.sh`/`.bat`/`.ps1`）也打进 zip 的 `_restore/`
- 🔒 **敏感保护**：`.credentials.yaml` / `.env` 快照内脱敏为 `***REDACTED***`；本机恢复时**跳过覆盖**，保留现有真实密钥
- 🧭 **按钮在设置**：撤销/恢复/快照列表放在 **设置 → 插件配置 → 快照归档** 卡片，不在顶部
- 🤖 **Agent 工具**：`snapshot_archive_create` / `snapshot_archive_list` / `snapshot_archive_restore`

## 安装

```sh
# 复制到 profile 的 node_modules
mkdir -p ~/.dsh/profiles/web/node_modules/dsh-snapshot-archive
cp -r lib package.json cordis.patch.yml ~/.dsh/profiles/web/node_modules/dsh-snapshot-archive/

# 注册依赖（package.json）
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('~/.dsh/profiles/web/package.json'));p.dependencies['dsh-snapshot-archive']='file:./node_modules/dsh-snapshot-archive';fs.writeFileSync('~/.dsh/profiles/web/package.json',JSON.stringify(p,null,2))"

# 注册插件（cordis.patch.yml 追加）
cat >> ~/.dsh/profiles/web/cordis.patch.yml << 'EOF'
- insert:
    - id: snapshot-archive
      name: dsh-snapshot-archive
EOF

# 重启 DSH
```

## 使用

- **界面**：设置 → 插件配置 → 快照归档：点「创建快照」存档，点列表里某条的「恢复」回滚
- **Agent**：
  ```
  snapshot_archive_create          # 创建快照
  snapshot_archive_list            # 列出快照
  snapshot_archive_restore id=xxx  # 恢复指定快照
  ```

## 快照内容

默认（`lib/spec.json`）：
- `profiles/<profile>/cordis.patch.yml`
- `profiles/<profile>/package.json`
- `profiles/<profile>/cordis.yml`
- `profiles/<profile>/pnpm-workspace.yaml`
- `settings.yaml`
- `.credentials.yaml`（脱敏）

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/snapshot-archive/status` | 状态（快照数/根目录/profile） |
| GET | `/api/snapshot-archive/list` | 快照列表 |
| POST | `/api/snapshot-archive/snapshot` | 创建快照 `{reason}` |
| POST | `/api/snapshot-archive/restore` | 恢复 `{id}` |
| POST | `/api/snapshot-archive/remove` | 删除 `{id}` |

## 手动恢复（解压即恢复）

zip 内自带 `_restore/` 脚本：
```sh
# Linux/macOS
sh _restore/restore-dsh.sh
# Windows
restore-dsh.bat   # 或 powershell -File restore-dsh.ps1
```
或直接把 zip 解压到 `~/.dsh` 根目录覆盖。

## License

MIT
