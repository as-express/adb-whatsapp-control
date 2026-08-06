set -euo pipefail

NATIVE_IME="com.samsung.android.honeyboard/.service.HoneyBoardService"
ADB_IME="com.android.adbkeyboard/.AdbIME"

if [ "${1:-}" = "--restore-ime" ]; then
  adb shell ime set "$NATIVE_IME"
  echo "✓ родная клавиатура возвращена"
  exit 0
fi

if [ "${1:-}" = "-f" ]; then
  [ -f "${2:-}" ] || { echo "✗ файл не найден: ${2:-}"; exit 1; }
  TEXT="$(cat "$2")"
  PHONE="${3:?укажи номер, напр. 77787689588}"
else
  TEXT="${1:?укажи текст или -f файл}"
  PHONE="${2:?укажи номер, напр. 77787689588}"
fi
SEND="${SEND:-0}"

NUM="$(printf '%s' "$PHONE" | tr -cd '0-9')"
case "$NUM" in
  8??????????) NUM="7${NUM:1}" ;;
esac
if [ "${#NUM}" -ne 11 ]; then
  echo "✗ номер '$NUM' содержит ${#NUM} цифр, а нужно 11 (7 + 10 цифр)."
  echo "  Пример: +7 778 768 95 88  ->  77787689588"
  exit 1
fi

adb wait-for-device
CUR_IME="$(adb shell settings get secure default_input_method | tr -d '\r')"
if [ "$CUR_IME" != "$ADB_IME" ]; then
  echo "✗ активна клавиатура '$CUR_IME', а нужна ADBKeyboard."
  echo "  Включи:  adb shell ime set $ADB_IME"
  exit 1
fi

center_of() {
  local id="$1"
  adb shell uiautomator dump /sdcard/_ui.xml >/dev/null 2>&1
  adb shell cat /sdcard/_ui.xml 2>/dev/null | tr '<' '\n<' \
    | grep -oE "resource-id=\"com\.whatsapp:id/${id}\"[^/]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" \
    | grep -oE '\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' | head -1 \
    | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1 \2 \3 \4/' \
    | awk 'NF==4 {print int(($1+$3)/2), int(($2+$4)/2)}'
}

wait_for() {
  local id="$1" tries="${2:-15}" c
  for ((i=0; i<tries; i++)); do
    c=$(center_of "$id" || true)
    [ -n "$c" ] && { printf '%s' "$c"; return 0; }
    sleep 1
  done
  return 1
}

echo "→ открываю чат с +$NUM"
adb shell input keyevent KEYCODE_WAKEUP >/dev/null
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/${NUM}" >/dev/null 2>&1

ENTRY=$(wait_for entry 20) || { echo "✗ поле ввода не появилось — чат не открылся"; exit 1; }
adb shell input tap $ENTRY
sleep 1

B64="$(printf '%s' "$TEXT" | base64 -w 0)"
adb shell am broadcast -a ADB_INPUT_B64 --es msg "$B64" >/dev/null
sleep 2

if [ "$SEND" != "1" ]; then
  echo "✓ текст напечатан (${#TEXT} симв.), НЕ отправлен — SEND=1 чтобы отправить"
  exit 0
fi

SENDBTN=$(wait_for send 10) || { echo "✗ кнопка отправки не найдена"; exit 1; }
adb shell input tap $SENDBTN
sleep 2
echo "✓ отправлено (${#TEXT} симв.)"
