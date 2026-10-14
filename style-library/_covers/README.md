# 智能剪辑封面（模式卡）

`智能剪辑` 面板切换类型时的三张模式卡（产品讲解 / 漫剧解说 / 技术分享）共用
`<style>/<version>/preview/cover.jpg` 这一份缩略图，所以这里放的是生成它们的中间产物。

## 目录

| 路径 | 内容 |
| --- | --- |
| `grounds/` | 已经按卡片比例裁好的底图，脚本直接吃这几个文件 |
| `frames/` | 从参考视频里抽出来的候选原帧，`grounds/` 由它们裁出来 |
| `preview/` | 渲染出的 1600×900 成品 PNG |
| `backup/` | 被替换掉的旧 `cover.jpg` |

## 复现

```bash
node scripts/make-style-covers.mjs                 # 三张都出到 _covers/preview
node scripts/make-style-covers.mjs --only tech     # 只重出技术分享
```

渲染方式是 `scripts/make-episode-cover.mjs` 那一套：Playwright 无头 Chromium 截
HTML/SVG，字体用 `assets/fonts/Alibaba-PuHuiTi-Heavy.ttf`。

装回面板：

```powershell
$ff = "$PWD\tools\ffmpeg\ffmpeg.exe"
& $ff -i style-library\_covers\preview\product-talk.png -q:v 3 -y style-library\armani-yulong-clean-talk\0001\preview\cover.jpg
& $ff -i style-library\_covers\preview\manhua-talk.png  -q:v 3 -y style-library\black-circle-pip-scene-tags\0001\preview\cover.jpg
& $ff -i style-library\_covers\preview\tech-talk.png    -q:v 3 -y style-library\tech-share-chapter-progress\0001\preview\cover.jpg
```

`/__studio/style-library/asset` 带 `cache-control: private, max-age=300`，换完图要
硬刷新一次面板（普通 F5 可能仍读缓存）。

## 底图取法

模式卡是 16:9，`object-fit: cover`，所以底图都预裁到接近卡片比例，避免人物在卡片里被切头。

| 底图 | 来源 | 裁切 |
| --- | --- | --- |
| `grounds/product-talk.png` | armani 参考片 t=6.3s | `crop=544:588:0:40`（避开片中烧录字幕） |
| `grounds/manhua-left.png` | `outputs/bitian-guan-03/cover-frames/p1-3x4.png` | `crop=530:596:0:12` |
| `grounds/manhua-right.png` | `outputs/bitian-guan-03/cover-frames/p2-3x4.png` | `crop=530:596:0:96` |
| `grounds/tech-presenter.png` | tech 风格 `analysis/evidence-4-broll-insert.jpg` | `crop=780:440:240:140`（避开顶部章节条和底部字幕） |

漫剧那两张是 `outputs/bitian-guan-03` 里那一期《仙逆·避天棺》的封面帧：`漫剧解说`
这一档目前挂的拆解风格（`黑底圆形场景标签`）还是香水素材，"仙逆对位"更贴近这一档要卖的
东西。副作用是 `拆解风格` 列表里那一项也跟着换成了仙逆图 —— 如果之后要让两边用不同图，
得给风格库加一个独立于 `preview` 的卡片图字段。

## 三张卡的设计约定

同一套骨架，靠主色和版式区分类型：

- 顶部一条主色横条 + 左上角「类型 + 英文」，右上角品牌位。
- 一行大字标题，深色描边，压在压暗层上，缩到卡片尺寸仍能读。
- 产品讲解用浅色真人底图 + 深色右栏；漫剧解说用冷/暖双人对位 + 中缝亮线；
  技术分享用深色幻灯片 + 主播画中画 + 01–04 步骤条。
