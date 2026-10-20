import { DEFAULT_BOT_AVATAR, type BotAvatar } from "@t3tools/contracts/bot";

export const BOT_AVATAR_COLORS = {
  blue: "#5c76b8",
  moss: "#4a7b65",
  amber: "#ad7031",
  rose: "#a95f78",
  graphite: "#59606e",
} as const;

export const BOT_AVATAR_PARTS = [
  { key: "shape", label: "Head", choices: ["rounded", "square", "circle"] },
  { key: "eyes", label: "Eyes", choices: ["dots", "visor", "happy"] },
  { key: "mouth", label: "Mouth", choices: ["smile", "flat", "grille"] },
] as const;
export const BOT_AVATAR_COLOR_NAMES = ["blue", "moss", "amber", "rose", "graphite"] as const;

export function botAvatarSvg(avatar: BotAvatar = DEFAULT_BOT_AVATAR): string {
  const color = BOT_AVATAR_COLORS[avatar.color];
  const shell =
    avatar.shape === "circle"
      ? `<circle cx="32" cy="35" r="23" fill="${color}"/>`
      : `<rect x="9" y="15" width="46" height="40" rx="${avatar.shape === "square" ? 5 : 13}" fill="${color}"/>`;
  const eyes = {
    visor: '<rect x="21" y="30" width="22" height="5" rx="2.5" fill="#f8fafc"/>',
    happy:
      '<path d="M22 34q3-6 6 0m8 0q3-6 6 0" fill="none" stroke="#f8fafc" stroke-width="2.5" stroke-linecap="round"/>',
    dots: '<circle cx="25" cy="32" r="3" fill="#f8fafc"/><circle cx="39" cy="32" r="3" fill="#f8fafc"/>',
  }[avatar.eyes];
  const mouth = {
    grille:
      '<path d="M25 41h14m-10-2v4m6-4v4" fill="none" stroke="#f8fafc" stroke-width="2" stroke-linecap="round"/>',
    smile:
      '<path d="M26 40q6 6 12 0" fill="none" stroke="#f8fafc" stroke-width="2" stroke-linecap="round"/>',
    flat: '<path d="M27 42h10" fill="none" stroke="#f8fafc" stroke-width="2" stroke-linecap="round"/>',
  }[avatar.mouth];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
    avatar.antenna
      ? `<path d="M32 15V8" stroke="${color}" stroke-width="3"/><circle cx="32" cy="6" r="3" fill="${color}"/>`
      : "",
    `<rect x="4" y="28" width="8" height="15" rx="4" fill="${color}"/><rect x="52" y="28" width="8" height="15" rx="4" fill="${color}"/>`,
    shell,
    '<rect x="16" y="24" width="32" height="23" rx="8" fill="#172033"/>',
    eyes,
    mouth,
    "</svg>",
  ].join("");
}
