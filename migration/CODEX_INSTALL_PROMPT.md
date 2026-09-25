请在当前 Windows 电脑上直接帮我安装并启动 Hypit 迁移环境。

迁移包路径：

```text
C:\HYPIT_MIGRATION
```

开始前请先请求我授权访问这个目录，不要删除、移动或改写迁移包中的源文件。迁移包内包含火山引擎凭证，只能在本机处理，不要上传到公共网盘、GitHub 或其他第三方服务。

请按以下步骤执行，并自行处理过程中出现的非破坏性问题：

1. 检查目录中的 `Bootstrap-Hypit.ps1`、`workspace` 和 `tools`。
2. 检查 `node -v`，必须是 `22.15.0` 以上；最佳版本是 `24.14.1`。
3. 如果 Node 不存在或版本过低，告诉我需要安装的 Node 版本，并在我授权后安装。
4. 运行 `corepack enable`。如果这台电脑没有 corepack，则安装 `pnpm@10.33.0`。
5. 进入迁移包根目录，运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\Bootstrap-Hypit.ps1
```

6. 引导脚本完成后，运行：

```powershell
.\Start-HypitStudio.ps1 -Port 4317
```

7. 确认以下地址返回 HTTP 200：

```text
http://localhost:4317/__studio#studio
```

8. 如果 4317 被占用，使用 4318，并告诉我最终实际地址。
9. 安装完成后报告：
   - Node 版本
   - pnpm 版本
   - Bootstrap 是否成功
   - Studio 实际 URL
   - 是否有任何错误或缺失文件

不要只告诉我命令，请直接执行安装并把我带到可用的 Studio 页面。
