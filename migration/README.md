# Hypit 开发迁移

目标是在另一台 Windows 电脑复现当前 Hypit Studio、风格库、ASR 配置和渲染质量。

## 迁移内容

迁移包包含：

- `workspace/hypit-local-demo`：本地 Hypit 工作树，包括 Studio 导出、风格库和本地改动。
- `workspace/.git`：完整的 `hypit-workspace` 仓库，可在新电脑继续拉取和提交。
- `workspace/style-library`：已归档的剪辑风格和参考分析。
- `workspace/playbook`：8 步视频制作流程、JSON 模板和门禁校验器。
- `workspace/component-library`：标题、字幕、转场、版式、贴纸和场景块的状态登记。
- `workspace/scripts`：未进入 Git 的本地配音、ASR、镜头检索和审片脚本。
- `workspace/HYPIT_STYLE_SELECTION.json`：当前勾选风格。
- `workspace/HYPIT_EDITING_PROTOCOL.md`：剪辑复用规则。
- `workspace/hypit.runtime.json`：默认 Runtime，包括豆包 ASR 接入。
- `tools/ffmpeg`：当前用于成片渲染的 FFmpeg/FFprobe。
- `tools/browser-cache`：可选，HyperFrames 浏览器缓存。
- `workspace/config.json`：可选，火山引擎 ASR/TOS 凭证。包含密钥，只能通过可信介质私下传输。

不复制 `node_modules`。新电脑会根据 `pnpm-lock.yaml` 安装同一批依赖，避免 Windows 链接路径失效。

两个 GitHub 仓库的完整跟踪文件都会进入迁移包：

- `hypit-workspace`：位于 `workspace`，包含 `.git`。
- `hypit-workbench`：位于 `workspace/hypit-local-demo`，包含 `.git`。

迁移包不是只复制运行所需子集；新电脑拿到后可以继续执行 `git pull`、提交和推送。

## 质量锁定

- Node：`.node-version`，`24.14.1`
- pnpm：`10.33.0`
- Hypit：`0.1.13`
- HyperFrames：`0.7.101`
- FFmpeg：`9.0.1-essentials_build`
- 渲染：`quality=standard`，H.264 CRF 23，preset medium，yuv420p
- 浏览器：`browserGpu=software`，`workers=2`

只改变 CPU 速度不会改变这些参数。不要在新电脑上换用系统自带 FFmpeg，否则 CRF、filter 和编码器版本可能不同。

## 1. 在当前电脑生成迁移包

在 PowerShell 中运行：

```powershell
Set-Location 'C:\Users\admin\Documents\视频制作'
.\migration\Prepare-HypitTransfer.ps1 `
  -Destination 'D:\HypitTransfer' `
  -IncludeBrowserCache `
  -IncludeCredentials
```

如果目标电脑可以正常联网下载依赖，可去掉 `-IncludeBrowserCache`。如果不想复制火山引擎密钥，可去掉 `-IncludeCredentials`，再到新电脑手动放置 `workspace\config.json`。

生成的目录是：

```text
D:\HypitTransfer\HYPIT_MIGRATION\
  workspace\
  tools\
  Prepare-HypitTransfer.ps1
  Bootstrap-Hypit.ps1
  Start-HypitStudio.ps1
  quality-lock.json
```

然后把整个 `HYPIT_MIGRATION` 目录复制到新电脑。直接从原盘复制到移动硬盘即可，不需要压缩；如果压缩，必须使用支持大文件的格式。

## 2. 在新电脑准备基础软件

只安装两项：

1. Node.js `24.14.1` Windows x64。
2. 在 PowerShell 运行 `corepack enable`。

不必单独安装 Hypit、HyperFrames 或 FFmpeg，迁移包会使用锁定版本。

## 3. 在新电脑引导

把迁移包放在例如：

```text
D:\HypitTransfer\HYPIT_MIGRATION
```

运行：

```powershell
Set-Location 'D:\HypitTransfer\HYPIT_MIGRATION'
Set-ExecutionPolicy -Scope Process Bypass
.\Bootstrap-Hypit.ps1
```

引导脚本会：

- 检查 Node 版本。
- 使用 pnpm `10.33.0` 和 `pnpm-lock.yaml` 安装依赖。
- 把所有 Runtime Profile 的 FFmpeg/FFprobe 指向迁移包内的 `tools\ffmpeg`。
- 将 `hypit.runtime.json` 的火山引擎 `configPath` 指向迁移后的 `workspace\config.json`。
- 将渲染质量显式写成 `standard`、`workers=2`、`browserGpu=software`。
- 初始化浏览器缓存。

## 4. 启动 Studio

```powershell
.\Start-HypitStudio.ps1 -Port 4317
```

默认打开最近的新素材工程：

```text
workspace\hypit-local-demo\examples\style-clone-20260828-img2411\edit.svrun
```

也可以指定其他工程：

```powershell
.\Start-HypitStudio.ps1 `
  -RunPath '.\workspace\hypit-local-demo\examples\style-clone-23-perfume\edit.svrun' `
  -Port 4317
```

## 5. 验证与以后剪辑

打开：

```text
http://localhost:4317/__studio#studio
```

新电脑会读取同一份风格库。以后收到新素材时，沿用当前流程：

1. 先运行 `node playbook/validate.mjs`。
2. 按 `playbook/templates/` 建立本次工程的阶段文件。
3. 在 Studio 左侧勾选需要的风格。
4. 把新素材路径和时长要求发给 Codex。
5. Codex 读取 `HYPIT_STYLE_SELECTION.json` 和 `component-library/index.json`。
6. 复用相同版本的风格分析，组件只有 `verified` 才能进入正式交付。
7. 构建、检查并导出 MP4，再用 `node playbook/validate.mjs --project <工程目录>` 验收。

## 常见偏差

- 如果新电脑使用系统 FFmpeg：画面仍可能正常，但编码参数和滤镜版本不受锁定时，质量不保证一致。
- 如果只复制 SVML/SVS：会缺少风格库、字体、媒体或运行环境，不能保证复现。
- 如果只使用上游 Git 仓库：会缺少当前 Studio 风格栏、导出按钮、豆包 ASR 和本地未提交修改。
- 如果复制了 `node_modules` 但换了路径：Windows junction 可能失效。推荐按锁文件重新安装。
- `config.json` 含有火山引擎密钥，不要发送到公开仓库或公共网盘。
