import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adb, shell, sleep, currentIme, setIme, listDevices,
  installedWhatsApps, foregroundActivity, ADB_IME, WA_PACKAGES,
} from './adb.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APK = join(ROOT, 'ADBKeyboard.apk');
const STATE = join(ROOT, '.state', 'devices.json');

async function readState() {
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

export async function isKeyboardInstalled() {
  const out = await shell(['pm', 'list', 'packages', 'com.android.adbkeyboard']).catch(() => '');
  return out.includes('com.android.adbkeyboard');
}

export async function isWhatsAppInstalled() {
  return (await installedWhatsApps()).length > 0;
}
export async function probeLogin(app) {
  const pkg = WA_PACKAGES[app];
  await shell(['input', 'keyevent', 'KEYCODE_HOME']);
  await sleep(800);
  await shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']).catch(() => {});
  await sleep(4000);
  const activity = (await foregroundActivity()) ?? '';
  await shell(['input', 'keyevent', 'KEYCODE_HOME']);

  if (!activity.startsWith(`${pkg}/`)) {
    return { app, pkg, loggedIn: false, activity, reason: 'App not exist' };
  }
  const loggedIn = !/registration|EULA|verify/i.test(activity);
  return {
    app, pkg, loggedIn, activity,
    ...(loggedIn ? {} : { reason: 'Acount not exist' }),
  };
}

export async function nativeImeFor(serial) {
  const state = await readState();
  if (state[serial]?.nativeIme) return state[serial].nativeIme;

  const cur = await currentIme();
  if (cur && cur !== ADB_IME) return cur;

  const list = await shell(['ime', 'list', '-s']).catch(() => '');
  const fallback = list.split('\n').map((s) => s.trim()).filter((s) => s && s !== ADB_IME)[0];
  return fallback || null;
}

export async function provision({ activate = true } = {}) {
  const devices = await listDevices();
  if (devices.length === 0) {
    return { ok: false, code: 'NO_DEVICE', error: 'Device not connected or not approved by hand' };
  }
  if (devices.length > 1) {
    return { ok: false, code: 'MULTIPLE_DEVICES', error: `Connected devices: ${devices.join(', ')}` };
  }
  const serial = devices[0];
  const steps = [];

  const whatsapps = await installedWhatsApps();
  if (whatsapps.length === 0) {
    return { ok: false, code: 'NO_WHATSAPP', serial, error: 'Whatsapp not found in device' };
  }
  steps.push({ step: 'whatsapp', ok: true, installed: whatsapps });

  const nativeIme = await nativeImeFor(serial);
  const state = await readState();
  state[serial] = { ...(state[serial] || {}), nativeIme, seenAt: new Date().toISOString() };
  await writeState(state);
  steps.push({ step: 'native-ime', ok: Boolean(nativeIme), value: nativeIme });

  if (!(await isKeyboardInstalled())) {
    if (!existsSync(APK)) {
      return { ok: false, code: 'NO_APK', serial, steps, error: `Нет файла ${APK}` };
    }
    await adb(['install', '-r', APK], { timeout: 120_000 });
    steps.push({ step: 'install-keyboard', ok: true, installed: true });
  } else {
    steps.push({ step: 'install-keyboard', ok: true, installed: false });
  }

  await shell(['ime', 'enable', ADB_IME]);
  steps.push({ step: 'enable-ime', ok: true });

  if (activate) {
    await setIme(ADB_IME);
    steps.push({ step: 'activate-ime', ok: true });
  }

  const probes = [];
  for (const app of whatsapps) probes.push(await probeLogin(app));
  const usable = probes.filter((p) => p.loggedIn).map((p) => p.app);
  steps.push({ step: 'login-check', ok: usable.length > 0, probes });

  const preferredApp = usable[0] ?? null;
  const st2 = await readState();
  st2[serial] = { ...(st2[serial] || {}), nativeIme, preferredApp, usableApps: usable };
  await writeState(st2);

  if (usable.length === 0) {
    return {
      ok: false, code: 'NO_LOGGED_IN_APP', serial, whatsapps, steps,
      error: 'No Whatsapp accounts setup please check your device',
    };
  }

  return {
    ok: true, serial, nativeIme, activeIme: await currentIme(),
    whatsapps, usableApps: usable, preferredApp, steps,
  };
}

export async function preferredAppFor(serial) {
  const state = await readState();
  return state[serial]?.preferredApp ?? null;
}

export async function restoreNativeIme() {
  const devices = await listDevices();
  if (devices.length !== 1) {
    return { ok: false, code: 'NO_DEVICE', error: 'Need connected device' };
  }
  const serial = devices[0];
  const native = await nativeImeFor(serial);
  if (!native) {
    return { ok: false, code: 'NO_NATIVE_IME', serial, error: 'Error to known origin keyboard' };
  }
  await setIme(native);
  return { ok: true, serial, ime: await currentIme() };
}
