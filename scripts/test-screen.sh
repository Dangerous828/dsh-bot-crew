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

# Android 14 把 `settings put global` 收紧了：adb shell 不再持有 WRITE_SECURE_SETTINGS，
# 直接写会抛 SecurityException。所以能不写设置就不写 —— 下面这些命令实测都能用：
#   cmd display set-brightness <0..1>   压亮度（系统会夹到最低一档）
#   input keyevent KEYCODE_SLEEP        进 doze，背光灭，adb 仍在（实测稳定）
#   input keyevent KEYCODE_WAKEUP       醒回来
#   svc power stayon true               充电时别睡
# 写不进去时只提示，不当失败：adb 本身还是通的，测试照跑。
stay_awake() {
  if ! "${A[@]}" shell settings put global stay_on_while_plugged_in 3 >/dev/null 2>&1; then
    echo "note: 这台 ROM 不让 adb 改 stay_on_while_plugged_in（Android 14 起常见）。" >&2
    echo "      插着电时仍可能睡下去；真要长时间跑，去开发者选项里手动打开「充电时不锁定屏幕」。" >&2
  fi
  "${A[@]}" shell svc power stayon true >/dev/null 2>&1 || true
}

case "${1:-}" in
  dark)
    stay_awake
    # 亮度压到最低而不是「关屏」：关屏后截图全黑，测试里要抓画面就什么都拿不到。
    # `cmd display set-brightness` 走的是 DisplayManager，不经过 SettingsProvider，
    # 所以不受 Android 14 那道权限收紧的影响。系统会把它夹到最低的一档（实测是 1）。
    # 顺序要紧：先唤醒、解锁，再压亮度。反过来的话，唤醒这一步会让系统按环境光
    # 把亮度重新算回去（实测 awake 之后亮度从 1 跳到 4101），前面压的等于白做。
    "${A[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    sleep 1
    # 唤醒后系统通常停在锁屏上：不解锁的话顶层是空的，截图抓到的还是锁屏。
    "${A[@]}" shell input keyevent 82 >/dev/null 2>&1 || true
    sleep 1
    # 压一次不够：唤醒之后系统会按环境光再算一遍，把刚压下去的顶回来（实测 1 -> 4091）。
    # 这里检查实际值，没压住就再压，最多试几次。压住之后只要不再唤醒就不会反弹。
    for _ in 1 2 3 4 5; do
      "${A[@]}" shell cmd display set-brightness 0 >/dev/null 2>&1 || \
        "${A[@]}" shell settings put system screen_brightness 0 >/dev/null 2>&1 || true
      sleep 1
      level=$("${A[@]}" shell settings get system screen_brightness 2>/dev/null | tr -d '\r')
      # 硬件下限是 4（dumpsys display 的 mScreenBrightnessRangeMinimum），设 0 会被夹到 1~4，
      # 所以「压住了」的判据是落到两位数以内，不是等于 0。
      [ "${level:-999}" -le 10 ] && break
    done
    echo "dark: 亮度已压到最低、屏幕保持点亮。截图与触控正常，坏线看不出来。"
    echo "      注意：这台机器关不掉自动亮度（adb 没有 WRITE_SETTINGS），再唤醒一次亮度会弹回去，重跑即恢复。"
    ;;
  off)
    stay_awake
    # KEYCODE_SLEEP 让系统入睡，背光灭掉。实测（PEDM00 / Android 14）doze 下 adb 仍然通，
    # 而且能随时 WAKEUP 醒回来 —— 这是三种模式里最省电的一种。
    # 代价是截图全黑：doze 时系统不渲染，screencap 拿到的是空画面（实测 25K 全黑）。
    # 要抓画面就用 dark 或 vd。
    "${A[@]}" shell input keyevent KEYCODE_SLEEP >/dev/null 2>&1 || true
    sleep 2
    if "${A[@]}" shell true >/dev/null 2>&1; then
      echo "off: 背光已关，adb 仍在。截图会是全黑的（doze 不渲染，这是预期的）。"
      echo "     要抓画面改用 dark；要恢复显示：test-screen.sh on"
    else
      echo "off: 这条 ROM 关屏时会断 adb。改用 dark 或 vd。" >&2
      exit 1
    fi
    ;;
  on)
    # 交给系统自己按当前环境光重算亮度，比我们自己写一个数更接近「还原」。
    "${A[@]}" shell cmd display reset-brightness-configuration >/dev/null 2>&1 || true
    "${A[@]}" shell settings put system screen_off_timeout 600000 >/dev/null 2>&1 || true
    "${A[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    echo "on: 亮度已交回系统，屏幕已唤醒。"
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
    printf 'device:                   %s\n' "$("${A[@]}" shell getprop ro.product.model | tr -d '\r') $( "${A[@]}" shell getprop ro.build.version.release | tr -d '\r')"
    "${A[@]}" shell dumpsys power 2>/dev/null | grep -E 'mWakefulness=' | head -1 || true
    ;;
  reset)
    "${A[@]}" shell settings put global stay_on_while_plugged_in 0 >/dev/null 2>&1 || true
    "${A[@]}" shell svc power stayon false >/dev/null 2>&1 || true
    "${A[@]}" shell cmd display reset-brightness-configuration >/dev/null 2>&1 || true
    "${A[@]}" shell settings put system screen_off_timeout 600000 >/dev/null 2>&1 || true
    "${A[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    echo "reset: 本次改动已全部还原。"
    ;;
  *) usage; exit 1 ;;
esac
