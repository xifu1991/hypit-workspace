function assTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(total / 360000);
  const minutes = Math.floor((total % 360000) / 6000);
  const secs = Math.floor((total % 6000) / 100);
  const centis = total % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    + `.${String(centis).padStart(2, "0")}`;
}

function safeText(value) {
  if (/[\\{}]/u.test(value)) throw new Error("brand text must not contain backslashes or braces");
  return value;
}

/**
 * Build an ASS brand mark that moves in a straight line and reflects off the safe-area walls.
 * Each `\move` segment runs at the same speed; only its direction changes at a collision.
 */
export function buildBouncingBrandAss({
  width,
  height,
  duration,
  text = "贝噜漫剧",
  font,
  fontSize = 44,
  alpha = 128,
  speedX = 56,
  speedY = 37,
  marginX = 24,
  marginTop = 76,
  marginBottom = 142,
  layer = 7,
}) {
  if (!(width > 0 && height > 0 && duration > 0)) {
    throw new Error("width, height and duration must be positive");
  }
  const label = safeText(text);
  const brandWidth = Math.ceil(fontSize * [...label].length + fontSize * 0.3);
  const brandHeight = Math.ceil(fontSize * 1.2);
  const minX = marginX;
  const maxX = Math.max(minX, width - marginX - brandWidth);
  const minY = marginTop;
  const maxY = Math.max(minY, height - marginBottom - brandHeight);
  const events = [];
  let x = minX;
  let y = minY;
  let vx = speedX;
  let vy = speedY;
  let cursor = 0;

  while (cursor < duration - 0.001) {
    const toXWall = Math.abs((vx > 0 ? maxX - x : x - minX) / vx);
    const toYWall = Math.abs((vy > 0 ? maxY - y : y - minY) / vy);
    const remaining = duration - cursor;
    const step = Math.min(toXWall, toYWall, remaining);
    const nextX = Math.min(maxX, Math.max(minX, x + vx * step));
    const nextY = Math.min(maxY, Math.max(minY, y + vy * step));
    const end = Math.min(duration, cursor + step);

    if (end - cursor >= 0.02) {
      const durationMs = Math.max(1, Math.round(step * 1000));
      events.push(`Dialogue: ${layer},${assTime(cursor)},${assTime(end)},Brand,,0,0,0,,`
        + `{\\an7\\move(${x.toFixed(2)},${y.toFixed(2)},${nextX.toFixed(2)},${nextY.toFixed(2)},0,${durationMs})`
        + `\\alpha&H${alpha.toString(16).padStart(2, "0").toUpperCase()}&}${label}`);
    }

    cursor = end;
    if (cursor >= duration - 0.001) break;
    x = nextX;
    y = nextY;
    if (Math.abs(step - toXWall) <= 0.0005) vx = -vx;
    if (Math.abs(step - toYWall) <= 0.0005) vy = -vy;
  }

  return [
    "[Script Info]",
    `; Bouncing brand: ${label}`,
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,"
      + " Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,"
      + " Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Brand,${font},${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H00101010,`
      + "-1,0,0,0,100,100,2,0,1,1.4,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
