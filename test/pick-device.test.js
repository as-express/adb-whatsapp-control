import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// подменяем файл состояния ДО импорта модулей, чтобы не трогать реальный .state
const STATE_FILE = join(await mkdtemp(join(tmpdir(), 'wa-test-')), 'devices.json');
process.env.WA_STATE_FILE = STATE_FILE;

const { pickDevice, normalizePhone, WhatsAppError } = await import('../lib/whatsapp.js');
const { ADB_IME } = await import('../lib/adb.js');

const setState = (obj) => writeFile(STATE_FILE, JSON.stringify(obj));

/** Заглушка телефона: ведёт себя как Device для inspectDevice(). */
function fakeDevice(serial, { model = serial, apps = [], ime = ADB_IME, loggedIn = [] } = {}) {
  return {
    serial,
    model: async () => model,
    installedWhatsApps: async () => apps,
    currentIme: async () => ime,
    // probeLogin сюда не дойдёт: в тестах ставим кэш либо пустой список приложений
    keyevent: async () => {},
    shell: async () => '',
    foregroundActivity: async () => (loggedIn.length ? 'com.whatsapp/HomeActivity' : ''),
  };
}

test('берёт телефон с залогиненным WhatsApp, пропуская негодные', async () => {
  const noWa = fakeDevice('AAA', { apps: [] });
  const good = fakeDevice('BBB', { apps: ['business'] });

  await setState({ BBB: { usableApps: ['business'], preferredApp: 'business' } });

  const { device, info } = await pickDevice({ devices: [noWa, good] });
  assert.equal(device.serial, 'BBB');
  assert.deepEqual(info.usableApps, ['business']);
});

test('телефон без ADBKeyboard пропускается', async () => {
  await setState({ BBB: { usableApps: ['business'], preferredApp: 'business' } });
  const wrongIme = fakeDevice('CCC', { apps: ['whatsapp'], ime: 'com.google.android.inputmethod.latin/x' });
  const good = fakeDevice('BBB', { apps: ['business'] });

  const { device } = await pickDevice({ devices: [wrongIme, good] });
  assert.equal(device.serial, 'BBB');
});

test('когда ни один не годится — ошибка перечисляет причины', async () => {
  const noWa = fakeDevice('AAA', { apps: [] });
  const wrongIme = fakeDevice('CCC', { apps: ['whatsapp'], ime: 'other/ime' });

  await assert.rejects(
    () => pickDevice({ devices: [noWa, wrongIme] }),
    (err) => {
      assert.ok(err instanceof WhatsAppError);
      assert.equal(err.code, 'NO_USABLE_DEVICE');
      assert.match(err.message, /AAA/);
      assert.match(err.message, /CCC/);
      assert.match(err.message, /no WhatsApp installed/);
      return true;
    },
  );
});

test('явный serial: несуществующий -> DEVICE_NOT_FOUND', async () => {
  await setState({ BBB: { usableApps: ['business'] } });
  const good = fakeDevice('BBB', { apps: ['business'] });
  await assert.rejects(
    () => pickDevice({ serial: 'ZZZ', devices: [good] }),
    (err) => err.code === 'DEVICE_NOT_FOUND',
  );
});

test('запрошенное приложение выбирает телефон, где оно залогинено', async () => {
  await setState({
    BBB: { usableApps: ['business'] },
    DDD: { usableApps: ['whatsapp'] },
  });
  const b = fakeDevice('BBB', { apps: ['business'] });
  const d = fakeDevice('DDD', { apps: ['whatsapp'] });

  const r1 = await pickDevice({ app: 'whatsapp', devices: [b, d] });
  assert.equal(r1.device.serial, 'DDD');

  const r2 = await pickDevice({ app: 'business', devices: [b, d] });
  assert.equal(r2.device.serial, 'BBB');
});

test('нормализация номера', () => {
  assert.equal(normalizePhone('+7 747 451 81 21'), '77474518121');
  assert.equal(normalizePhone('87474518121'), '77474518121');
  assert.equal(normalizePhone('7474518121'), '77474518121');
  assert.throws(() => normalizePhone('123'), (e) => e.code === 'BAD_PHONE');
});
