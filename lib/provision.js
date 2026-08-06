import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDeviceObjects, sleep, ADB_IME, WA_PACKAGES } from './adb.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APK = join(ROOT, 'ADBKeyboard.apk');
// переопределяется в тестах, чтобы не затирать реальные настройки телефонов
const STATE = process.env.WA_STATE_FILE || join(ROOT, '.state', 'devices.json');

export async function readState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 2));
}

async function patchState(serial, patch) {
  const state = await readState();
  state[serial] = { ...(state[serial] || {}), ...patch };
  await writeState(state);
  return state[serial];
}

export async function isKeyboardInstalled(device) {
  const out = await device.shell(['pm', 'list', 'packages', 'com.android.adbkeyboard']).catch(() => '');
  return out.includes('com.android.adbkeyboard');
}

export async function probeLogin(device, app) {
  const pkg = WA_PACKAGES[app];
  await device.keyevent('KEYCODE_HOME');
  await sleep(800);
  await device.shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']).catch(() => {});
  await sleep(4000);
  const activity = (await device.foregroundActivity()) ?? '';
  await device.keyevent('KEYCODE_HOME');

  if (!activity.startsWith(`${pkg}/`)) {
    return { app, pkg, loggedIn: false, activity, reason: 'app did not come to foreground' };
  }
  const loggedIn = !/registration|EULA|verify/i.test(activity);
  return {
    app, pkg, loggedIn, activity,
    ...(loggedIn ? {} : { reason: 'registration screen — account not linked' }),
  };
}

export async function nativeImeFor(device) {
  const state = await readState();
  if (state[device.serial]?.nativeIme) return state[device.serial].nativeIme;

  const cur = await device.currentIme();
  if (cur && cur !== ADB_IME) return cur;

  return (await device.imeList()).find((s) => s !== ADB_IME) || null;
}

export async function provisionDevice(device, { activate = true } = {}) {
  const serial = device.serial;
  const steps = [];
  const model = await device.model();

  const whatsapps = await device.installedWhatsApps();
  if (whatsapps.length === 0) {
    await patchState(serial, { model, whatsapps: [], usableApps: [], preferredApp: null });
    return { ok: false, code: 'NO_WHATSAPP', serial, model, error: 'WhatsApp not installed on this device' };
  }
  steps.push({ step: 'whatsapp', ok: true, installed: whatsapps });

  const nativeIme = await nativeImeFor(device);
  await patchState(serial, { model, nativeIme, seenAt: new Date().toISOString() });
  steps.push({ step: 'native-ime', ok: Boolean(nativeIme), value: nativeIme });

  if (!(await isKeyboardInstalled(device))) {
    if (!existsSync(APK)) {
      return { ok: false, code: 'NO_APK', serial, model, steps, error: `Missing file ${APK}` };
    }
    await device.adb(['install', '-r', APK], { timeout: 120_000 });
    steps.push({ step: 'install-keyboard', ok: true, installed: true });
  } else {
    steps.push({ step: 'install-keyboard', ok: true, installed: false });
  }

  await device.enableIme(ADB_IME);
  steps.push({ step: 'enable-ime', ok: true });

  if (activate) {
    await device.setIme(ADB_IME);
    steps.push({ step: 'activate-ime', ok: true });
  }

  const probes = [];
  for (const app of whatsapps) probes.push(await probeLogin(device, app));
  const usable = probes.filter((p) => p.loggedIn).map((p) => p.app);
  steps.push({ step: 'login-check', ok: usable.length > 0, probes });

  const preferredApp = usable[0] ?? null;
  await patchState(serial, { whatsapps, usableApps: usable, preferredApp });

  if (usable.length === 0) {
    return {
      ok: false, code: 'NO_LOGGED_IN_APP', serial, model, whatsapps, steps,
      error: 'No WhatsApp account is logged in on this device',
    };
  }

  return {
    ok: true, serial, model, nativeIme, activeIme: await device.currentIme(),
    whatsapps, usableApps: usable, preferredApp, steps,
  };
}

export async function provisionAll(opts) {
  const devices = await listDeviceObjects();
  if (devices.length === 0) {
    return { ok: false, code: 'NO_DEVICE', error: 'No device connected or authorized' };
  }
  const results = [];
  for (const d of devices) {
    try {
      results.push(await provisionDevice(d, opts));
    } catch (err) {
      results.push({ ok: false, serial: d.serial, code: 'SETUP_FAILED', error: err.message });
    }
  }
  const ready = results.filter((r) => r.ok);
  return {
    ok: ready.length > 0,
    total: results.length,
    ready: ready.length,
    ...(ready.length === 0 ? { code: 'NO_USABLE_DEVICE', error: 'No connected device has a logged-in WhatsApp' } : {}),
    devices: results,
  };
}

export async function preferredAppFor(serial) {
  return (await readState())[serial]?.preferredApp ?? null;
}

export async function restoreNativeIme(serial) {
  const devices = await listDeviceObjects();
  if (devices.length === 0) {
    return { ok: false, code: 'NO_DEVICE', error: 'No device connected' };
  }
  const targets = serial ? devices.filter((d) => d.serial === serial) : devices;
  if (targets.length === 0) {
    return { ok: false, code: 'NO_DEVICE', error: `Device ${serial} is not connected` };
  }

  const results = [];
  for (const d of targets) {
    const native = await nativeImeFor(d);
    if (!native) {
      results.push({ ok: false, serial: d.serial, code: 'NO_NATIVE_IME', error: 'Could not determine original keyboard' });
      continue;
    }
    await d.setIme(native);
    results.push({ ok: true, serial: d.serial, ime: await d.currentIme() });
  }
  return { ok: results.every((r) => r.ok), devices: results };
}
