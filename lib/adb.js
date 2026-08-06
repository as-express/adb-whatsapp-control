import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const ADB_IME = 'com.android.adbkeyboard/.AdbIME';

export const WA_PACKAGES = {
  whatsapp: 'com.whatsapp',
  business: 'com.whatsapp.w4b',
};

export async function adb(args, { timeout = 30_000 } = {}) {
  const { stdout } = await exec('adb', args, { timeout, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function shell(args, opts) {
  return adb(['shell', ...args], opts);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listDevices() {
  const out = await adb(['devices']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
}

export async function installedWhatsApps() {
  const out = await shell(['pm', 'list', 'packages']).catch(() => '');
  const lines = out.split('\n').map((l) => l.trim());
  return Object.entries(WA_PACKAGES)
    .filter(([, pkg]) => lines.includes(`package:${pkg}`))
    .map(([key]) => key);
}

export async function foregroundActivity(tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const out = await shell(['dumpsys', 'window']);
      const m = out.match(/mCurrentFocus=Window\{[^}]*\s+(\S+\/\S+)\}/);
      if (m) return m[1];
    } catch {}
    await sleep(500);
  }
  return null;
}

export async function foregroundPackage() {
  const act = await foregroundActivity();
  return act ? act.split('/')[0] : null;
}

export async function currentIme() {
  const out = await shell(['settings', 'get', 'secure', 'default_input_method']);
  return out.trim();
}

export async function setIme(ime) {
  await shell(['ime', 'set', ime]);
}

export async function centerOf(resourceId) {
  await shell(['uiautomator', 'dump', '/sdcard/_api_ui.xml']).catch(() => {});
  const xml = await shell(['cat', '/sdcard/_api_ui.xml']).catch(() => '');
  const re = new RegExp(
    `resource-id="${resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
  );
  const m = xml.match(re);
  if (!m) return null;
  const [, x1, y1, x2, y2] = m.map(Number);
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

export async function waitFor(resourceId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const c = await centerOf(resourceId);
    if (c) return c;
    await sleep(1000);
  }
  return null;
}

export async function tap({ x, y }) {
  await shell(['input', 'tap', String(x), String(y)]);
}

export async function typeUnicode(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  await shell(['am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
}

export async function clearField() {
  await shell(['am', 'broadcast', '-a', 'ADB_CLEAR_TEXT']);
}
