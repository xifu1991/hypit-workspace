# 弹球品牌文字

动漫剪辑默认品牌水印。旧版“贝噜剪辑 + logo”图片不再使用，改为 50% 透明度的“贝噜漫剧”文字。

- 文字在安全区内匀速直线移动，碰到左、右、上、下边界后按入射方向反射。
- 1920x1080 默认安全区为左右 24px、顶部 76px、底部 142px，避免盖住顶部章节条和底部字幕。
- 每条 `\move` 路径段速度一致；碰撞只改变方向，不改变速度。

```js
import { buildBouncingBrandAss } from "./component-library/bouncing-brand/brand.mjs";

const ass = buildBouncingBrandAss({
  width: 1920,
  height: 1080,
  duration: 121.8,
  text: "贝噜漫剧",
  font: "Alibaba PuHuiTi H",
  fontSize: 44,
  alpha: 128,
});
```

`alpha: 128` 是约 50% 透明度。将生成的 ASS 放在字幕和章节条之后烧入画面。
