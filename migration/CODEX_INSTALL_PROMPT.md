# Hypit 新电脑一键安装提示词

把下面整段发给新电脑上的 Codex。

```text
请直接在这台 Windows 电脑上完整安装并启动 Hypit Studio，不要只给操作步骤。遇到普通问题请自行排查并继续，需要管理员权限或安装软件时再请求授权。

迁移包路径：
D:\HypitFast_20261026\HYPIT_MIGRATION

如果路径不存在，请在 D:\ 下查找最新的 HYPIT_MIGRATION\Bootstrap-Hypit.ps1，并先让我确认。禁止使用 D:\HypitTransfer 里的旧迁移包。

迁移包内已经包含两个完整仓库：

1. hypit-workspace
   位置：迁移包\workspace
   应包含 .git、样式库、组件库、playbook、迁移文档、SaaS 和网关代码。

2. hypit-workbench
   位置：迁移包\workspace\hypit-local-demo
   应包含 .git 和 Hypit 的完整 1839 个 Git 跟踪文件。

不要重新 clone GitHub，也不要只复制运行子集。先验证两个目录都能执行 git status，并保留现有 .git。

安全要求：

- workspace\config.json 包含火山引擎凭证，不要上传 GitHub、公共网盘或其他第三方服务，也不要把完整密钥输出到聊天中。
- 不要删除迁移包中的源文件、素材、风格库或 Git 元数据。
- Bootstrap 为了修正本机路径，可以改写 runtime.json，并允许安装 node_modules。

执行流程：

1. 检查迁移包是否包含 Bootstrap-Hypit.ps1、workspace、scripts、tools\ffmpeg、tools\browser-cache。
2. 分别检查 workspace 和 workspace\hypit-local-demo 的 Git 元数据，确认工作区仓库有 314 个跟踪文件，Hypit 仓库有 1839 个跟踪文件。
3. 检查 node -v。如果没有 Node 或版本低于 22.15.0，安装 Node.js 24.14.1 Windows x64，然后重新打开 PowerShell。
4. 不要单独安装 FFmpeg、HyperFrames、Hypit CLI、Python 或 Chromium，迁移包已经包含。
5. 配置 pnpm：

corepack enable
corepack prepare pnpm@10.33.0 --activate

如果失败，改用：

npm install -g pnpm@10.33.0

6. 启动引导：

Set-Location 'D:\HypitFast_20261026\HYPIT_MIGRATION'
Set-ExecutionPolicy -Scope Process Bypass -Force
.\Bootstrap-Hypit.ps1

引导必须使用迁移包内的 FFmpeg 和浏览器缓存，不要重复下载。

7. 启动 Studio：

.\Start-HypitStudio.ps1 -Port 4320

如果 4320 被占用，依次尝试 4321、4322，并报告实际地址。

8. 等待并访问以下地址，确认返回 HTTP 200，然后帮我打开：

http://localhost:4320/__studio#studio

9. 如果失败，读取 studio-4320.err.log 和 studio-4320.out.log，自行修复非破坏性问题后重试。

完成后报告：

- 迁移包实际路径
- 两个仓库的 git rev-parse HEAD
- 两个仓库的跟踪文件数量
- Node 和 pnpm 版本
- Bootstrap 是否成功
- Studio 实际 URL
- 是否使用包内 FFmpeg 和浏览器缓存
- 任何错误或缺失文件

请持续执行到 Studio 页面真正可用为止。
```
