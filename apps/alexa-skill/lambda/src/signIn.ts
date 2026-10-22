import qrcode from 'qrcode-generator';

// Mirrors the Fire TV app's device-code sign-in (MockAuthService): the screen
// shows a QR code, the player scans it and approves on their phone. There is no
// backend yet, so codes are generated here and never actually approved.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
export const VERIFICATION_URI = 'https://haunt.example/activate'; // placeholder until a real domain exists

export interface SignInCode {
  userCode: string;
  qrValue: string;
}

function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

export function createSignInCode(): SignInCode {
  const userCode = `${randomCode(4)}-${randomCode(4)}`;
  return { userCode, qrValue: `${VERIFICATION_URI}?code=${encodeURIComponent(userCode)}` };
}

/**
 * Builds an APL vector graphic (AVG) of the QR code. APL can't draw the SVG or
 * data-URI images the Fire TV app uses, so each run of dark modules in a row
 * becomes one rectangle in a single path.
 */
export function qrGraphic(value: string, margin = 2) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  let pathData = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      const start = col;
      while (col + 1 < count && qr.isDark(row, col + 1)) col++;
      const length = col - start + 1;
      pathData += `M${start + margin},${row + margin}h${length}v1h-${length}z`;
    }
  }

  const size = count + margin * 2;
  return {
    type: 'AVG',
    version: '1.2',
    width: size,
    height: size,
    items: [
      { type: 'path', pathData: `M0,0h${size}v${size}h-${size}z`, fill: '#FFFFFF' },
      { type: 'path', pathData, fill: '#000000' },
    ],
  };
}
