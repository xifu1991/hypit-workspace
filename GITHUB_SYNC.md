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

## 第二台电脑：获取代码

```powershell
New-Item -ItemType Directory -Force -Path 'C:\HYPIT'
Set-Location 'C:\HYPIT'

git clone 'git@github.com:YOUR_NAME/hypit-workbench.git' 'hypit-workbench'
Set-Location 'C:\HYPIT\hypit-workbench'
git remote add upstream 'https://github.com/hypit-ai/hypit.git'
```

第二台电脑获取工作区：

```powershell
Set-Location 'C:\HYPIT'
git clone 'git@github.com:YOUR_NAME/hypit-workspace.git' 'hypit-workspace'
```

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

## 质量同步原则

两台电脑升级后必须保持一致：

- 同一 Node 版本
- 同一 pnpm 版本
- 同一 `pnpm-lock.yaml`
- 同一 FFmpeg 版本
- 同一 HyperFrames 版本
- 同一渲染参数

代码提交后，第二台电脑先 `git pull`，再重新运行 `Bootstrap-Hypit.ps1` 或 `pnpm install --frozen-lockfile`。不要凭记忆手动升级单个依赖。
