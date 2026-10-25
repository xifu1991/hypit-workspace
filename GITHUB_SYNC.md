# GitHub 双电脑同步方案

目标：两台电脑都能继续优化 Hypit，并且可以互相获取代码、风格库和配置模板更新。

## 推荐结构

使用两个私有 GitHub 仓库：

1. `hypit-workbench`
   - 来源：当前 `hypit-local-demo`
   - 保存 Hypit 代码、Studio 修改、豆包 ASR Provider、本项目新增功能
   - 保留 `upstream` 指向 `https://github.com/hypit-ai/hypit.git`
   - 新增 `origin` 指向自己的私有 Fork

2. `hypit-workspace`
   - 保存 `style-library`、风格选择、编辑协议和迁移脚本
   - 不保存源视频、成片、缓存和火山引擎密钥

大型素材可使用移动硬盘、NAS、对象存储或百度网盘同步，不进入代码仓库。

## 当前电脑：代码仓库

先在 GitHub 创建私有仓库，例如：

```text
git@github.com:YOUR_NAME/hypit-workbench.git
```

然后执行：

```powershell
Set-Location 'C:\Users\admin\Documents\视频制作\hypit-local-demo'

git remote rename origin upstream
git remote add origin 'git@github.com:YOUR_NAME/hypit-workbench.git'
git checkout -b workbench/main

git add -A
git commit -m "feat: local Hypit workbench"
git push -u origin workbench/main
```

如果当前电脑已经使用过 GitHub SSH，这一步可以直接推送。如果没有，需要先配置 SSH Key。

### GitHub Token 权限

Hypit 官方仓库包含 `.github/workflows/`。使用 HTTPS + Personal Access Token 推送时，
Token 必须允许创建或更新 Workflow 文件：

- Classic Token：勾选 `repo` 和 `workflow`
- Fine-grained Token：给目标仓库 `Contents: Read and write` 和 `Workflows: Read and write`

如果只勾选普通仓库权限，推送会报：

```text
refusing to allow a Personal Access Token to create or update workflow
```

以后更新上游 Hypit：

```powershell
git fetch upstream
git merge upstream/main
```

解决冲突后再推送：

```powershell
git push origin workbench/main
```

## 当前电脑：工作区仓库

创建另一个私有仓库：

```text
git@github.com:YOUR_NAME/hypit-workspace.git
```

然后执行：

```powershell
Set-Location 'C:\Users\admin\Documents\视频制作'

git init
git remote add origin 'git@github.com:YOUR_NAME/hypit-workspace.git'

git add style-library playbook component-library
git add HYPIT_EDITING_PROTOCOL.md HYPIT_STYLE_LIBRARY_DISCOVERY.md HYPIT_STYLE_SELECTION.json
git add hypit.runtime.json hypit_node_preload.cjs
git add migration GITHUB_SYNC.md
git add start_studio_4317_img2411.ps1

git commit -m "feat: Hypit styles and workspace automation"
git push -u origin main
```

根目录的 `.gitignore` 必须继续排除：

```text
config.json
outputs/
assets/
.hypit/
.pnpm-store/
node_modules/
*.log
*.mp4
*.mov
*.wav
__pycache__/
.venv/
```

## 第二台电脑：首次获取代码

```powershell
Set-Location "$HOME\Documents"

git clone 'https://github.com/xifu1991/hypit-workspace.git' '视频制作'
Set-Location '视频制作'
git clone -b workbench/main 'https://github.com/xifu1991/hypit-workbench.git' 'hypit-local-demo'
```

这里必须保持 `视频制作\hypit-local-demo` 的嵌套结构，现有启动脚本、同步脚本和相对路径都依赖它。如果第二台电脑已经有工作区，只需要进入原目录执行 `git pull --rebase`，代码仓也执行一次 `git pull --rebase`。

首次运行前，从模板创建本机环境文件，再填写各自的密钥：

```powershell
Set-Location 'hypit-tenant-gateway'
Copy-Item '.env.example' '.env'
```

真实的 `config.json`、`.env`、SSH 私钥和服务器数据库不会进入 Git，也不应通过聊天发送。需要原样迁移这些配置时，请使用密码管理器、加密压缩包或服务器密钥管理系统。

## 日常双电脑协作

当前电脑可以直接使用一键脚本：

```powershell
Set-Location 'C:\Users\admin\Documents\视频制作'

# 查看两个仓库状态
.\Sync-HypitGit.ps1 -Action Status

# 一次性拉取两个仓库
.\Sync-HypitGit.ps1 -Action Pull

# 提交并推送两个仓库
.\Sync-HypitGit.ps1 -Action Push -Message "描述本次优化"
```

第二台电脑如果目录不同：

```powershell
.\Sync-HypitGit.ps1 `
  -Action Pull `
  -CodeRepo 'C:\HYPIT\hypit-workbench' `
  -WorkspaceRepo 'C:\HYPIT\hypit-workspace'
```

脚本只是依次对两个仓库执行 Git，不需要手动打开两个文件夹。

每次开始工作前：

```powershell
git pull --rebase
```

完成优化后：

```powershell
git add -A
git commit -m "描述本次修改"
git push
```

两边最好使用不同分支：

```text
workbench/computer-a
workbench/computer-b
```

优化完成后通过 Pull Request 合并到 `workbench/main`。不要两边同时直接修改 `main`，否则容易出现冲突。

## 必须排除的内容

不提交：

- `config.json`：火山引擎 ASR/TOS 密钥
- `.hypit/`：运行缓存和构建数据库
- `outputs/`：成片
- `examples/**/assets/`：源视频和中间音频
- `.pnpm-store/`：包缓存
- `node_modules/`：依赖安装结果
- 浏览器缓存和 FFmpeg 二进制

应提交：

- `package.json`
- `pnpm-lock.yaml`
- `packages/` 下的代码
- `examples/*.svml`、`.svs`、`.svrun`
- `style-library/` 的分析和预览
- `playbook/` 的流程、模板和校验器
- `component-library/` 的组件状态、版本和授权记录
- `HYPIT_STYLE_SELECTION.json`
- `hypit.runtime.json` 模板，但不含密钥
- `migration/` 引导脚本

## 不会随 git 自动同步的东西

两台电脑效果不一致，通常不是模型理解不同，而是下面这些根本不在仓库里：

- **Skill 本体**：`C:\Users\admin\.codex\skills\hypit` 不是 git 仓库，是每台机器单独安装的。第二台必须执行同样的安装或更新，并保持版本一致：

  ```powershell
  npx skills add hypit-ai/hypit -g    # 首次安装
  npx skills update hypit -g          # 更新
  ```

- **`scripts/`**：被 `.gitignore` 排除。配音（`narration-doubao.ts`）、ASR、镜头检索等入口只在单机存在，换电脑要单独拷，或者另建仓库管理。
- **`config.json`**：火山凭证和 TTS 音色表，按设计不进仓库，第二台需要单独配置。
- **`tools/`、`.venv/`、`node_modules/`**：FFmpeg、Whisper 权重、依赖都在本机安装，版本按下面的「质量同步原则」对齐。
- **`assets/`、`sample_*`、`outputs/**` 里的媒体**：只有白名单内的 json / md / ps1 / 证据帧会同步，源视频、成片、中间音频不会。第二台看不到同样的素材，agent 只能靠文字猜画面，很多「按帧量」的规则（L-002、L-003、L-015）在那边无法执行。
- **`.hypit/runtimes/`**：构建数据库和 worker 状态，属于机器本地，不需要同步。
- **聊天里的判断**：不会同步。只有写进 `HYPIT_LESSONS.md`、`playbook/` 或项目文档的决定，另一台电脑的 agent 才看得到。注意 `ChatGPT\视频制作ds版本` 这个工作区目前没有任何提交和远端，写在那里的经验等于只留在本机。

## 路径约定必须一致

本机的工作区是嵌套结构：`视频制作\hypit-local-demo`。而上面「第二台电脑」的命令把代码仓 clone 成兄弟目录 `C:\HYPIT\hypit-workbench`，这会造成：

- `start_studio_*.ps1` 里的 `Join-Path $root "hypit-local-demo"` 找不到；
- `Sync-HypitGit.ps1` 默认的 `$PSScriptRoot\hypit-local-demo` 找不到（必须显式传 `-CodeRepo`）；
- 工作区脚本里 `../hypit-local-demo/packages/...` 的相对 import 断掉；
- `hypit.runtime.json` 里 `configPath`、`ffmpegPath/ffprobePath` 是 `C:/Users/admin/...` 绝对路径，用户名或目录不同就失效。

两种做法选一种，不要混用：第二台也 clone 成 `<工作区>\hypit-local-demo`，或者统一改脚本和 runtime 里的路径。

## 质量同步原则

两台电脑升级后必须保持一致：

- 同一 Node 版本
- 同一 pnpm 版本
- 同一 `pnpm-lock.yaml`
- 同一 FFmpeg 版本
- 同一 HyperFrames 版本
- 同一渲染参数

代码提交后，第二台电脑先 `git pull`，再重新运行 `Bootstrap-Hypit.ps1` 或 `pnpm install --frozen-lockfile`。不要凭记忆手动升级单个依赖。
