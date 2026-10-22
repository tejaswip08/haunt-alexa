/**
 * Hand-drawn scene illustrations as SVG markup (Haunt's own artwork, not AI-generated).
 * Colours follow the mood tint `--tv-tint`. Classes starting with `fx-` are animation
 * hooks styled in fx.css; with motion off they are simply still.
 */

export const SETTINGS = ["lighthouse", "train", "hospital", "house", "forest", "water", "door", "figure"] as const;
export type Setting = (typeof SETTINGS)[number];

const INK = "#050407";
const INK_2 = "#0d0b12";
const GLOW = "rgb(var(--tv-tint, 120 40 40))";
const LIGHT = "#f4d9a0";

const moon = (x = 1220, y = 170, r = 70) => `
  <g class="fx-moon">
    <circle cx="${x}" cy="${y}" r="${r * 2.4}" fill="url(#art-light)" opacity="0.25"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="#e9e1cf" opacity="0.85"/>
    <circle cx="${x + r * 0.35}" cy="${y - r * 0.15}" r="${r * 0.92}" fill="${INK_2}" opacity="0.55"/>
  </g>`;

const DRAWINGS: Record<Setting, () => string> = {
  lighthouse: () => `
    ${moon(300, 160, 55)}
    <polygon class="fx-beam" points="905,262 1600,120 1600,330" fill="${LIGHT}" opacity="0.12"/>
    <path d="M0 760 Q300 700 600 740 T1100 720 T1600 760 V900 H0Z" fill="${INK}"/>
    <path d="M760 760 L820 300 H900 L960 760Z" fill="${INK}"/>
    <rect x="800" y="250" width="120" height="60" fill="${INK}"/>
    <rect class="fx-lamp" x="822" y="262" width="76" height="38" fill="${LIGHT}" opacity="0.85"/>
    <path d="M790 250 L860 190 L930 250Z" fill="${INK}"/>
    <rect x="845" y="420" width="30" height="46" fill="${LIGHT}" opacity="0.35"/>
    <path class="fx-swell" d="M0 820 Q400 790 800 830 T1600 810 V900 H0Z" fill="${INK_2}" opacity="0.9"/>`,

  train: () => `
    ${moon(1350, 140, 45)}
    <rect x="0" y="640" width="1600" height="260" fill="${INK}"/>
    <rect x="0" y="628" width="1600" height="12" fill="${GLOW}" opacity="0.4"/>
    <g class="fx-train">
      <rect x="180" y="380" width="1100" height="250" rx="24" fill="${INK}"/>
      ${[240, 420, 600, 780, 960]
        .map((x, i) => `<rect x="${x}" y="430" width="130" height="90" rx="8" fill="${LIGHT}" opacity="${i === 2 ? 0.85 : 0.18}"${i === 2 ? ' class="fx-window"' : ""}/>`)
        .join("")}
      <rect x="1140" y="430" width="70" height="200" fill="${LIGHT}" opacity="0.5"/>
      <path d="M1170 630 h20 v-90 a14 14 0 1 0 -20 0z" fill="${INK}"/>
    </g>
    ${[160, 520, 880, 1240]
      .map(
        (x, i) => `<g>
          <rect x="${x}" y="120" width="10" height="520" fill="${INK}"/>
          <rect x="${x - 30}" y="120" width="70" height="14" fill="${INK}"/>
          <circle class="${i === 1 ? "fx-flicker" : i === 3 ? "fx-flicker fx-late" : ""}" cx="${x + 5}" cy="150" r="40" fill="url(#art-light)" opacity="0.35"/>
        </g>`,
      )
      .join("")}`,

  hospital: () => `
    <path d="M0 0 H1600 V900 H0Z" fill="${INK}" opacity="0.35"/>
    <path d="M520 0 L620 900 H980 L1080 0Z" fill="${INK_2}" opacity="0.6"/>
    <path d="M0 900 L620 520 H980 L1600 900Z" fill="${INK}"/>
    <rect x="620" y="200" width="360" height="320" fill="${INK}"/>
    <rect class="fx-fluoro" x="760" y="300" width="80" height="220" fill="${LIGHT}" opacity="0.5"/>
    <path class="fx-window-shadow" d="M770 330 a14 16 0 1 1 0.1 0 M760 360 h22 l8 160 h-38z" fill="${INK}" opacity="0.85"/>
    ${[0, 1, 2, 3]
      .map((i) => `<rect x="${480 - i * 120}" y="${180 - i * 40}" width="70" height="${300 + i * 90}" fill="${LIGHT}" opacity="${0.06 + (i === 1 ? 0.12 : 0)}"${i === 1 ? ' class="fx-fluoro fx-late"' : ""}/>`)
      .join("")}
    ${[0, 1, 2, 3]
      .map((i) => `<rect x="${1050 + i * 120}" y="${180 - i * 40}" width="70" height="${300 + i * 90}" fill="${LIGHT}" opacity="0.06"/>`)
      .join("")}
    <rect x="380" y="640" width="260" height="70" rx="8" fill="${INK_2}"/>
    <rect x="390" y="610" width="90" height="40" rx="16" fill="#cfc6d8" opacity="0.18"/>
    <circle class="fx-pulse" cx="800" cy="120" r="34" fill="#d23b3b" opacity="0.8"/>`,

  house: () => `
    ${moon()}
    <path d="M0 720 Q400 680 800 700 T1600 690 V900 H0Z" fill="${INK}"/>
    <path d="M520 700 V420 L800 230 L1080 420 V700Z" fill="${INK}"/>
    <path d="M930 330 V250 H990 V370Z" fill="${INK}"/>
    <rect class="fx-candle" x="610" y="470" width="90" height="110" fill="${LIGHT}" opacity="0.75"/>
    <rect x="900" y="470" width="90" height="110" fill="${LIGHT}" opacity="0.12"/>
    <path class="fx-window-shadow" d="M935 500 a12 14 0 1 1 0.1 0 M925 525 h20 l6 55 h-32z" fill="${INK}" opacity="0.8"/>
    <rect x="760" y="560" width="80" height="140" fill="${LIGHT}" opacity="0.3"/>
    <rect class="fx-door" x="760" y="560" width="80" height="140" fill="${INK_2}"/>
    <circle cx="800" cy="350" r="34" fill="${LIGHT}" opacity="0.12"/>
    <path class="fx-sway" d="M200 700 V560 M190 590 L200 560 L210 590 M1350 700 V520 M1340 550 L1350 520 L1360 550" stroke="${INK}" stroke-width="14"/>`,

  forest: () => {
    const trees = [60, 210, 330, 500, 1080, 1230, 1380, 1520];
    return `
    ${moon(800, 200, 60)}
    <path d="M0 900 L720 600 Q800 580 880 600 L1600 900Z" fill="${INK_2}"/>
    <path d="M760 900 L790 600 H810 L840 900Z" fill="#cfc6d8" opacity="0.08"/>
    <path class="fx-distant" d="M1000 560 a9 10 0 1 1 0.1 0 M992 576 h17 l5 50 h-27z" fill="${INK}" opacity="0.9"/>
    ${trees
      .map(
        (x, i) => `<g opacity="${0.75 + (i % 3) * 0.1}">
          <rect x="${x}" y="${140 + (i % 4) * 30}" width="${34 + (i % 3) * 10}" height="800" fill="${INK}"/>
          <path class="fx-sway${i % 2 ? " fx-late" : ""}" style="transform-origin:${x + 17}px ${360 + (i % 2) * 60}px" d="M${x + 17} ${300 + (i % 2) * 60} l-120 -90 M${x + 17} 420 l110 -100" stroke="${INK}" stroke-width="14"/>
        </g>`,
      )
      .join("")}
    <circle class="fx-candle" cx="790" cy="610" r="10" fill="${LIGHT}" opacity="0.7"/>`;
  },

  water: () => `
    ${moon(1100, 190, 65)}
    <rect x="0" y="560" width="1600" height="340" fill="${INK}"/>
    ${[600, 650, 700, 760, 830]
      .map((y, i) => `<rect class="fx-ripple" style="animation-delay:${i * -1.3}s" x="${1020 - i * 30}" y="${y}" width="${160 + i * 60}" height="5" fill="#e9e1cf" opacity="${0.35 - i * 0.05}"/>`)
      .join("")}
    <path d="M0 560 Q300 540 520 560 L560 540 L640 560 Q900 550 1600 560 V570 H0Z" fill="${INK_2}"/>
    <g class="fx-bob"><path d="M240 600 h360 l-40 40 h-280z" fill="${INK_2}"/><rect x="400" y="470" width="10" height="130" fill="${INK_2}"/></g>
    <path d="M150 640 V900 M330 640 V900" stroke="${INK_2}" stroke-width="16"/>`,

  door: () => `
    <rect x="0" y="0" width="1600" height="900" fill="${INK}" opacity="0.45"/>
    <path d="M0 900 L560 620 H1040 L1600 900Z" fill="${INK}"/>
    <rect x="640" y="160" width="320" height="460" fill="${INK}"/>
    <path class="fx-flicker" d="M680 200 H920 V620 H680Z" fill="${LIGHT}" opacity="0.12"/>
    <path class="fx-door-leaf" d="M680 200 L860 240 V640 L680 620Z" fill="${INK_2}"/>
    <polygon points="680,620 920,620 1300,900 300,900" fill="${LIGHT}" opacity="0.08"/>
    <circle cx="840" cy="430" r="8" fill="${LIGHT}" opacity="0.6"/>
    ${[0, 1, 2, 3, 4]
      .map((i) => `<rect x="${560 - i * 60}" y="${620 + i * 56}" width="${480 + i * 120}" height="12" fill="${INK_2}"/>`)
      .join("")}`,

  figure: () => `
    <rect x="0" y="0" width="1600" height="900" fill="${INK}" opacity="0.3"/>
    <circle class="fx-breathe" cx="800" cy="360" r="300" fill="url(#art-light)" opacity="0.22"/>
    <path d="M0 760 H1600 V900 H0Z" fill="${INK}"/>
    <g class="fx-loom">
      <path d="M800 210 a46 52 0 1 1 -0.1 0z" fill="${INK}"/>
      <path d="M720 320 Q800 290 880 320 L930 760 H670Z" fill="${INK}"/>
      <path d="M690 420 L640 620 M910 420 L960 620" stroke="${INK}" stroke-width="26" stroke-linecap="round"/>
      <circle cx="782" cy="262" r="4" fill="${LIGHT}" opacity="0.7"/>
      <circle cx="818" cy="262" r="4" fill="${LIGHT}" opacity="0.7"/>
    </g>
    <path d="M670 760 Q800 800 930 760" fill="${INK_2}"/>`,
};

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);

/** SVG markup for a setting. `alt` is escaped; nothing else in the markup comes from the story. */
export function sceneArtSvg(setting: Setting, alt: string): string {
  const draw = DRAWINGS[setting] ?? DRAWINGS.house;
  return `<svg class="fx-art" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeXml(
    alt ? `Illustration: ${alt}` : "Scene illustration",
  )}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="art-sky" cx="50%" cy="30%" r="80%">
      <stop offset="0" stop-color="${GLOW}" stop-opacity="0.55"/>
      <stop offset="0.6" stop-color="${GLOW}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="art-light" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${LIGHT}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${LIGHT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1600" height="900" fill="${INK_2}"/>
  <rect width="1600" height="900" fill="url(#art-sky)"/>
  ${draw()}
</svg>`;
}
