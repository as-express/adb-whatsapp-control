import {
  adb, shell, sleep, waitFor, tap, typeUnicode, clearField,
  currentIme, listDevices, installedWhatsApps, foregroundActivity,
  ADB_IME, WA_PACKAGES,
} from './adb.js';

import { preferredAppFor } from './provision.js';

const DEFAULT_APP = process.env.WA_APP || 'whatsapp';

export class WhatsAppError extends Error {
  constructor(message, code, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  let num = digits;
  if (num.length === 11 && num.startsWith('8')) num = '7' + num.slice(1);
  if (num.length === 10) num = '7' + num; 
  if (num.length !== 11 || !num.startsWith('7')) {
    throw new WhatsAppError(
      `Phone "${raw}" give ${num.length} phone length — looking for 11 (7 + 10). example: 77787689588`,
      'BAD_PHONE',
      400,
    );
  }
  return num;
}

export async function resolveApp(requested, serial) {
  const installed = await installedWhatsApps();
  if (installed.length === 0) {
    throw new WhatsAppError('Whatsapp not exist in device', 'NO_WHATSAPP', 503);
  }

  if (requested) {
    if (!WA_PACKAGES[requested]) {
      throw new WhatsAppError(
        `Unknown value app="${requested}", accepted only: whatsapp | business`,
        'BAD_APP', 400,
      );
    }
    if (!installed.includes(requested)) {
      throw new WhatsAppError(
        `Device have not "${requested}" (${WA_PACKAGES[requested]}). installed: ${installed.join(', ')}`,
        'APP_NOT_INSTALLED', 503,
      );
    }
    return { app: requested, pkg: WA_PACKAGES[requested], installed };
  }

  const preferred = serial ? await preferredAppFor(serial) : null;
  if (preferred && installed.includes(preferred)) {
    return { app: preferred, pkg: WA_PACKAGES[preferred], installed, source: 'setup' };
  }
  const app = installed.length === 1
    ? installed[0]
    : (installed.includes(DEFAULT_APP) ? DEFAULT_APP : installed[0]);
  return { app, pkg: WA_PACKAGES[app], installed, source: 'fallback' };
}

export async function preflight() {
  const devices = await listDevices().catch(() => {
    throw new WhatsAppError('adb not exists — not installed or not in PATH', 'NO_ADB', 503);
  });
  if (devices.length === 0) {
    throw new WhatsAppError('Device not connected (adb devices exmpty)', 'NO_DEVICE', 503);
  }
  if (devices.length > 1) {
    throw new WhatsAppError(
      `connected many devices (${devices.join(', ')}) — keep only one`,
      'MULTIPLE_DEVICES', 503,
    );
  }
  const ime = await currentIme();
  if (ime !== ADB_IME) {
    throw new WhatsAppError(
      `Active keeyboard "${ime}", need ADBKeyboard. Prepare Device: POST /setup`,
      'WRONG_IME', 503,
    );
  }
  return { device: devices[0], ime, whatsapps: await installedWhatsApps() };
}

export async function sendMessage({ phone, message, send = false, app: requestedApp }) {
  const num = normalizePhone(phone);
  if (typeof message !== 'string' || message.length === 0) {
    throw new WhatsAppError('Message input empty', 'EMPTY_MESSAGE', 400);
  }

  const { device } = await preflight();
  const { app, pkg } = await resolveApp(requestedApp, device);

  await shell(['input', 'keyevent', 'KEYCODE_WAKEUP']);
  await shell(['am', 'start', '-a', 'android.intent.action.VIEW',
               '-d', `https://wa.me/${num}`, '-p', pkg]);

  const entry = await waitFor(`${pkg}:id/entry`, 20);
  if (!entry) {
    const act = (await foregroundActivity()) ?? '';
    if (/registration|EULA|verify/i.test(act)) {
      throw new WhatsAppError(
        `В "${app}" (${pkg}) not logined` +
        `Login to app by hand`,
        'APP_NOT_LOGGED_IN', 503,
      );
    }
    throw new WhatsAppError(
      `Text input not shown for 20 second — chat in ${pkg} not opened (display: ${act || 'unknown'})`,
      'CHAT_NOT_OPENED', 504,
    );
  }

  await tap(entry);
  await sleep(500);
  await clearField();
  await sleep(300);
  await typeUnicode(message);
  await sleep(1500);

  if (!send) {
    return { status: 'typed', sent: false, phone: num, device, app, pkg, chars: message.length };
  }

  const sendBtn = await waitFor(`${pkg}:id/send`, 10);
  if (!sendBtn) {
    throw new WhatsAppError(
      'Button send message not exist',
      'SEND_BUTTON_NOT_FOUND', 504,
    );
  }
  await tap(sendBtn);
  await sleep(1500);

  return { status: 'sent', sent: true, phone: num, device, app, pkg, chars: message.length };
}
