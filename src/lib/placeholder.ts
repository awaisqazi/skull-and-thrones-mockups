/**
 * Generated grey, diagonally striped SVG placeholder tiles (matches the mockups).
 * Returned as a data: URI: single quotes inside the SVG, '#' encoded as %23.
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function placeholder(width: number, height: number, label: string, seed: string = label): string {
  const h = hash(seed);
  const top = 140 + (h % 46); // 140–185
  const bottom = 45 + ((h >>> 8) % 46); // 45–90
  const size = Math.round(Math.min(width, height) * 0.07);
  const text = label.toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='rgb(${top},${top},${top})'/><stop offset='1' stop-color='rgb(${bottom},${bottom},${bottom})'/>` +
    `</linearGradient><pattern id='p' width='40' height='40' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'>` +
    `<rect width='40' height='40' fill='url(#g)'/><rect width='2' height='40' fill='rgba(255,255,255,0.12)'/></pattern></defs>` +
    `<rect width='${width}' height='${height}' fill='url(#p)'/>` +
    `<text x='50%' y='52%' text-anchor='middle' font-family='Helvetica,Arial,sans-serif' font-size='${size}' font-weight='700' fill='rgba(255,255,255,0.55)' letter-spacing='2'>${text}</text></svg>`;
  return (
    'data:image/svg+xml;charset=utf-8,' +
    svg.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/ /g, '%20')
  );
}
