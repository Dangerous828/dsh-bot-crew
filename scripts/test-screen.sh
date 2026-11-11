#!/usr/bin/env bash
# 把一台测试机切成「屏幕看不见 / 但 adb 一直在线」的状态。
#
# 用途：屏幕有坏线的机器只拿来跑测试。人不需要看它那块屏，测试却要一直连得上。
#
# 三个模式，按「屏幕到底要不要断电」区分 —— 这不是三种写法，是三种不同的取舍：
#   dark   屏幕亮着但亮度归零。最保险：触控、截图、录屏全都正常，只是看不见。
#   off    只关背光，系统保持唤醒（scrcpy -S 的做法）。省电，坏线也看不见，但截图是黑的。
#   vd     造一块虚拟屏，应用跑在上面，物理屏彻底不管。坏屏最彻底的一种绕法。
#
# 不管哪个模式，`stay_on_while_plugged_in` 都要开着：它是「充电时别睡」的那道保险，
# 关掉它，设备一进 doze，USB 调试就断，上面做的全都白费。
set -euo pipefail

DEVICE="${ANDROID_SERIAL:-}"
ADB="${ADB:-adb}"

# 没指定就要求恰好一台：连着两台时随便挑一台，改的是哪台只有天知道。
if [ -z "$DEVICE" ]; then
  COUNT=$("$ADB" devices | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' ')
  if [ "$COUNT" -ne 1 ]; then
    echo "连着 $COUNT 台设备。用 ANDROID_SERIAL=<序列号> 指定一台：" >&2
    "$ADB" devices -l >&2
    exit 1
  fi
  DEVICE=$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1}')
fi

A=("$ADB" -s "$DEVICE")

usage() {
  cat <<'EOF'
用法: test-screen.sh <dark|off|on|vd|status|reset>

  dark    亮度归零、不息屏 —— 屏幕亮着但什么都看不见，触控与截图照常
  off     关背光、系统保持唤醒（scrcpy -S 的做法）
  on      恢复亮度、恢复正常的息屏超时
  vd      在 Mac 上开一块虚拟屏（需要 scrcpy），物理屏不用管
  status  看现在是什么状态
  reset   把本次改动的设置全部还原

所有模式都会打开 stay_on_while_plugged_in —— 否则设备一睡，adb 就断。
EOF
}

stay_awake() {
  # 3 = AC + USB 都算「插着电」。用 2 只认 USB，用充电头供电时就不生效了。
  "${A[@]}" shell settings put global stay_on_while_plugged_in 3 >/dev/null
  "${A[@]}" shell svc power stayon true >/dev/null 2>&1 || true
}

case "${1:-}" in
  dark)
    stay_awake
    # 亮度 0 而不是「关屏」：关屏后截图全黑，测试里要抓画面就什么都拿不到。
    "${A[@]}" shell settings put system screen_brightness_mode 0 >/dev/null
    "${A[@]}" shell settings put system screen_brightness 0 >/dev/null
    # 不息屏：屏幕得亮着，亮度 0 才有意义。
    "${A[@]}" shell settings put system screen_off_timeout 2147483647 >/dev/null
    "${A[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    echo "dark: 亮度 0、屏幕常亮、设备不睡。截图与触控正常。"
    ;;
  off)
    stay_awake
    # KEYCODE_SLEEP 让系统入睡，背光灭掉，但 stay_on 的设置在充电时把它拉回来。
    # 这条在部分 ROM 上会连 adb 一起断（进入 doze），下一条命令就是体检。
    "${A[@]}" shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1 || true
    sleep 2
    if "${A[@]}" shell true >/dev/null 2>&1; then
      echo "off: 背光已关，adb 仍在。截图会是黑的（这是预期的）。"
      echo "     要恢复显示：test-screen.sh on"
    else
      echo "off: 这条 ROM 关屏时会断 adb。改用 dark 或 vd。" >&2
      exit 1
    fi
    ;;
  on)
    "${A[@]}" shell settings put system screen_brightness_mode 1 >/dev/null
    "${A[@]}" shell settings put system screen_off_timeout 1800000 >/dev/null
    "${A[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    echo "on: 亮度与息屏超时已还原。"
    ;;
  vd)
    # 虚拟屏是 Mac 这边的进程，不是设备的设置：它退出，虚拟屏就跟着销毁。
    command -v scrcpy >/dev/null || { echo "没装 scrcpy：brew install scrcpy" >&2; exit 1; }
    stay_awake
    echo "vd: 开虚拟屏 1280x720/240。Ctrl-C 结束。"
    exec scrcpy -s "$DEVICE" --new-display=1280x720/240 --no-audio
    ;;
  status)
    echo "设备: $DEVICE"
    printf 'stay_on_while_plugged_in: %s\n' "$("${A[@]}" shell settings get global stay_on_while_plugged_in | tr -d '\r')"
    printf 'screen_off_timeout:       %s\n' "$("${A[@]}" shell settings get system screen_off_timeout | tr -d '\r')"
    printf 'screen_brightness:        %s\n' "$("${A[@]}" shell settings get system screen_brightness | tr -d '\r')"
    "${A[@]}" shell dumpsys power 2>/dev/null | grep -E 'mWakefulness=' | head -1 || true
    ;;
  reset)
    "${A[@]}" shell settings put global stay_on_while_plugged_in 0 >/dev/null
    "${A[@]}" shell svc power stayon false >/dev/null 2>&1 || true
    "${A[@]}" shell settings put system screen_brightness_mode 1 >/dev/null
    "${A[@]}" shell settings put system screen_off_timeout 1800000 >/dev/null
    "${A[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    echo "reset: 本次改动已全部还原。"
    ;;
  *) usage; exit 1 ;;
esac
