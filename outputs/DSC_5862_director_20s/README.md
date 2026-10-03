# DSC_5862 导演版 20s · 可复现管线

这份工程是「最新效果」的标准实现：五段已拆解风格连续接力，每段画面出现方式都不同。
仓库里只放**代码、版式、编排文档和证据帧**，视频与字体仍然不进 Git，按下面步骤在本机重建即可。

## 工程里有什么

| 文件 | 作用 |
|---|---|
| `overlay/index.html` | 五段版式的全部实现（CSS + GSAP 时间轴），画面切换由 `body[data-shot]` 驱动 |
| `render-overlay.mjs` | 逐帧渲染脚本，用 Chrome 无头模式按时间轴 seek 后截图 |
| `brief.json` / `reference.json` / `material-plan.json` | 选题、参考与素材登记 |
| `shotbook.json` | 帧级编排表（切点 `0/157/266/407/503/612`） |
| `component-plan.json` | 每个镜头用到的组件、版本与覆盖值 |
| `qa.json` | 检查项、成片规格与已知限制 |
| `VISUAL_PLAN.md` | 导演视角的视觉编排说明 |
| `qa/evidence/` | 五个镜头的关键帧证据 |

## 复现步骤

### 0. 环境

- Node 22+
- Chrome（默认找 `C:\Program Files\Google\Chrome\Application\chrome.exe`）
- `puppeteer-core`：脚本会依次在工程目录、上级目录、`hypit-local-demo` 等处查找；
  找不到时用 `HYPIT_PUPPETEER_PACKAGE` 指向含 `node_modules` 的 `package.json`。
- Chrome 位置不标准时用 `HYPIT_CHROME_PATH` 指定。

### 1. 补回字体（不进仓库，约 32MB）

等线是 Windows 自带字体，直接复制即可：

```powershell
Copy-Item C:\Windows\Fonts\Deng.ttf  overlay\assets\Chinese-Regular.ttf
Copy-Item C:\Windows\Fonts\Dengb.ttf overlay\assets\Chinese-Bold.ttf
```

字体文件缺失时，`overlay/index.html` 会自动回落到系统安装的等线（`DengXian`），
所以即使跳过这一步也能渲染，只是不再锁定字节级一致。

### 2. 补回画面素材

`base-20s.mp4`（1920x1080 / 30fps / 20.400s）来自绿幕替换后的母版，
取 4.70s 起的 20.400 秒并统一到 30fps：

```powershell
ffmpeg -ss 4.70 -i DSC_5862_background_25s_complete.mp4 -t 20.40 `
  -vf fps=30 -c:v libx264 -crf 17 -preset medium -pix_fmt yuv420p `
  -c:a aac -b:a 192k base-20s.mp4

Copy-Item base-20s.mp4 overlay\assets\base-20s.mp4

# S005 圆窗用的独立方形特写（必须预裁，否则圆窗会跟着主画面一起推近）
ffmpeg -i base-20s.mp4 -vf "crop=520:520:700:30,fps=30" -an `
  -c:v libx264 -crf 17 -preset medium -pix_fmt yuv420p overlay\assets\face-closeup.mp4
```

重建后请对照 `qa/evidence/` 里的关键帧确认构图一致。

### 3. 渲染与编码

```powershell
# 整段 612 帧（约 3 分钟）
node render-overlay.mjs

# 只重渲染某个区间（调试用，例如 S005）
node render-overlay.mjs --frames=503-611

# 单帧抽查
node render-overlay.mjs --t=11,19

ffmpeg -y -framerate 30 -i qa\frames\frame_%05d.jpg -i base-20s.mp4 `
  -map 0:v -map 1:a -c:v libx264 -crf 17 -preset medium -pix_fmt yuv420p `
  -profile:v high -c:a copy -movflags +faststart DSC_5862_director_20s_final.mp4
```

### 4. 交付前校验

```powershell
node playbook\validate.mjs --project outputs\DSC_5862_director_20s
hyperframes lint          # 在 overlay 目录里跑，要求 0 error / 0 warning
hyperframes inspect       # 要求 0 layout issue
```

## 已知限制

- 中文字体单文件约 15.6MB，超过 HyperFrames 的 2MB 内联上限，因此成片走本地抽帧管线，
  HyperFrames 负责规则校验与动效约束，不参与最终渲染。
- `overlay/assets/base-20s.mp4` 与工程根目录的 `base-20s.mp4` 指向同一份内容，
  因为 composition 只允许引用项目根内的媒体。
- S005 的推近必须用 `transform: scale`，不要改成补间 `left/top/width/height`，
  否则慢速推近会出现整数像素跳变（见 `HYPIT_LESSONS.md` L-008）。
