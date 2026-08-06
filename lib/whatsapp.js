import { listDeviceObjects, sleep, ADB_IME, WA_PACKAGES } from './adb.js';
import { readState, preferredAppFor, probeLogin } from './provision.js';

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
      `Phone "${raw}" gives ${num.length} digits — expected 11 (7 + 10). Example: 77787689588`,
      'BAD_PHONE', 400,
    );
  }
  return num;
}

export async function inspectDevice(device, { allowProbe = true } = {}) {
  const serial = device.serial;
  const info = { serial, usableApps: [], reason: null };

  try {
    info.model = await device.model();
  } catch (err) {
    info.reason = `unreachable: ${err.message}`;
    return info;
  }

  const installed = await device.installedWhatsApps();
  info.whatsapps = installed;
  if (installed.length === 0) {
    info.reason = 'no WhatsApp installed';
    return info;
  }

  info.ime = await device.currentIme().catch(() => null);
  if (info.ime !== ADB_IME) {
    info.reason = `ADBKeyboard is not active (current: ${info.ime}) — run POST /setup`;
    return info;
  }

  const cached = (await readState())[serial];
  const cachedUsable = (cached?.usableApps ?? []).filter((a) => installed.includes(a));
  if (cachedUsable.length > 0) {
    info.usableApps = cachedUsable;
    info.source = 'cache';
    return info;
  }

  if (!allowProbe) {
    info.reason = 'login state unknown — run POST /setup';
    return info;
  }

  const probes = [];
  for (const app of installed) probes.push(await probeLogin(device, app));
  info.probes = probes;
  info.usableApps = probes.filter((p) => p.loggedIn).map((p) => p.app);
  info.source = 'probe';
  if (info.usableApps.length === 0) info.reason = 'no WhatsApp account logged in';
  return info;
}

export async function inspectAll(opts) {
  const devices = await listDeviceObjects();
  const out = [];
  for (const d of devices) out.push(await inspectDevice(d, opts));
  return out;
}

export async function pickDevice({ serial, app, devices: given } = {}) {
  const devices = given ?? await listDeviceObjects();
  if (devices.length === 0) {
    throw new WhatsAppError('No device connected (adb devices is empty)', 'NO_DEVICE', 503);
  }

  if (serial) {
    const target = devices.find((d) => d.serial === serial);
    if (!target) {
      throw new WhatsAppError(
        `Device "${serial}" is not connected. Connected: ${devices.map((d) => d.serial).join(', ')}`,
        'DEVICE_NOT_FOUND', 404,
      );
    }
    const info = await inspectDevice(target);
    if (info.usableApps.length === 0) {
      throw new WhatsAppError(
        `Device ${serial} is not usable: ${info.reason}`,
        'DEVICE_NOT_USABLE', 503,
      );
    }
    return { device: target, info };
  }

  const inspected = [];
  for (const d of devices) {
    const info = await inspectDevice(d);
    inspected.push(info);
    if (info.usableApps.length === 0) continue;
    if (app && !info.usableApps.includes(app)) continue;
    return { device: d, info };
  }

  const detail = inspected
    .map((i) => `${i.serial}${i.model ? ` (${i.model})` : ''}: ${i.reason ?? `logged in: ${i.usableApps.join(', ')}`}`)
    .join('; ');
  throw new WhatsAppError(
    app
      ? `No connected device has "${app}" logged in. Checked — ${detail}`
      : `No connected device has a logged-in WhatsApp. Checked — ${detail}`,
    'NO_USABLE_DEVICE', 503,
  );
}

export async function resolveApp(requested, info) {
  const usable = info.usableApps;

  if (requested) {
    if (!WA_PACKAGES[requested]) {
      throw new WhatsAppError(
        `Unknown app="${requested}", allowed: whatsapp | business`, 'BAD_APP', 400,
      );
    }
    if (!usable.includes(requested)) {
      throw new WhatsAppError(
        `"${requested}" is not logged in on ${info.serial}. Available: ${usable.join(', ') || 'none'}`,
        'APP_NOT_LOGGED_IN', 503,
      );
    }
    return { app: requested, pkg: WA_PACKAGES[requested] };
  }

  const preferred = await preferredAppFor(info.serial);
  const app = (preferred && usable.includes(preferred)) ? preferred
    : (usable.includes(DEFAULT_APP) ? DEFAULT_APP : usable[0]);
  return { app, pkg: WA_PACKAGES[app] };
}

export async function preflight(opts) {
  const devices = await inspectAll(opts);
  return {
    devices,
    usable: devices.filter((d) => d.usableApps.length > 0).map((d) => d.serial),
  };
}

export async function sendMessage({ phone, message, send = false, app: requestedApp, serial }) {
  const num = normalizePhone(phone);
  if (typeof message !== 'string' || message.length === 0) {
    throw new WhatsAppError('Field "message" is empty', 'EMPTY_MESSAGE', 400);
  }

  const { device, info } = await pickDevice({ serial, app: requestedApp });
  const { app, pkg } = await resolveApp(requestedApp, info);

  await device.keyevent('KEYCODE_WAKEUP');
  await device.shell(['am', 'start', '-a', 'android.intent.action.VIEW',
                      '-d', `https://wa.me/${num}`, '-p', pkg]);

  const entry = await device.waitFor(`${pkg}:id/entry`, 20);
  if (!entry) {
    const act = (await device.foregroundActivity()) ?? '';
    if (/registration|EULA|verify/i.test(act)) {
      throw new WhatsAppError(
        `"${app}" (${pkg}) is not logged in on ${device.serial} — registration screen opened`,
        'APP_NOT_LOGGED_IN', 503,
      );
    }
    throw new WhatsAppError(
      `Input field did not appear in 20s on ${device.serial} (screen: ${act || 'unknown'})`,
      'CHAT_NOT_OPENED', 504,
    );
  }

  await device.tap(entry);
  await sleep(500);
  await device.clearField();
  await sleep(300);
  await device.typeUnicode(message);
  await sleep(1500);

  const base = {
    phone: num, device: device.serial, model: info.model,
    app, pkg, chars: message.length,
  };

  if (!send) return { status: 'typed', sent: false, ...base };

  const sendBtn = await device.waitFor(`${pkg}:id/send`, 10);
  if (!sendBtn) {
    throw new WhatsAppError(
      'Send button not found — text left as draft', 'SEND_BUTTON_NOT_FOUND', 504,
    );
  }
  await device.tap(sendBtn);
  await sleep(1500);

  return { status: 'sent', sent: true, ...base };
}
