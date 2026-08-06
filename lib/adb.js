import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const ADB_IME = 'com.android.adbkeyboard/.AdbIME';

export const WA_PACKAGES = {
  whatsapp: 'com.whatsapp',
  business: 'com.whatsapp.w4b',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function adbRaw(args, { timeout = 30_000 } = {}) {
  const { stdout } = await exec('adb', args, { timeout, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function listDevices() {
  const out = await adbRaw(['devices']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
}

export class Device {
  constructor(serial) {
    if (!serial) throw new Error('Device требует серийник');
    this.serial = serial;
  }

  async adb(args, opts) {
    return adbRaw(['-s', this.serial, ...args], opts);
  }

  async shell(args, opts) {
    return this.adb(['shell', ...args], opts);
  }

  async model() {
    const out = await this.shell(['getprop', 'ro.product.model']).catch(() => '');
    return out.trim() || this.serial;
  }

  async installedWhatsApps() {
    const out = await this.shell(['pm', 'list', 'packages']).catch(() => '');
    const lines = out.split('\n').map((l) => l.trim());
    return Object.entries(WA_PACKAGES)
      .filter(([, pkg]) => lines.includes(`package:${pkg}`))
      .map(([key]) => key);
  }

  async foregroundActivity(tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        const out = await this.shell(['dumpsys', 'window']);
        const m = out.match(/mCurrentFocus=Window\{[^}]*\s+(\S+\/\S+)\}/);
        if (m) return m[1];
      } catch { /* повторим */ }
      await sleep(500);
    }
    return null;
  }

  async currentIme() {
    const out = await this.shell(['settings', 'get', 'secure', 'default_input_method']);
    return out.trim();
  }

  async setIme(ime) {
    await this.shell(['ime', 'set', ime]);
  }

  async enableIme(ime) {
    await this.shell(['ime', 'enable', ime]);
  }

  async imeList() {
    const out = await this.shell(['ime', 'list', '-s']).catch(() => '');
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async centerOf(resourceId) {
    const path = `/sdcard/_api_ui_${this.serial}.xml`;
    await this.shell(['uiautomator', 'dump', path]).catch(() => {});
    const xml = await this.shell(['cat', path]).catch(() => '');
    const re = new RegExp(
      `resource-id="${resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    );
    const m = xml.match(re);
    if (!m) return null;
    const [, x1, y1, x2, y2] = m.map(Number);
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }

  async waitFor(resourceId, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const c = await this.centerOf(resourceId);
      if (c) return c;
      await sleep(1000);
    }
    return null;
  }

  async tap({ x, y }) {
    await this.shell(['input', 'tap', String(x), String(y)]);
  }

  async keyevent(code) {
    await this.shell(['input', 'keyevent', code]);
  }

  async typeUnicode(text) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    await this.shell(['am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
  }

  async clearField() {
    await this.shell(['am', 'broadcast', '-a', 'ADB_CLEAR_TEXT']);
  }
}

export async function listDeviceObjects() {
  return (await listDevices()).map((s) => new Device(s));
}
