# 动态交互集成评审

## 设备约束

只操作 Redmi Xiaomi 24117RK2CC / zorn / `9f9cc3db`。重新插线后已重新识别；另一台 `R9AT507Z88X` 不安装、不录屏、不操作。所有设备命令显式使用 `adb -s 9f9cc3db`。

## 基线证据的适用范围

原始录像、XML 和真实发送状态均已读取。XML 验证只作结构辅助；`look_video` 已观察到顶栏不可见、空壳展开、卡片移除与消息位移。不能将联系图请求时间当作编码原生帧 PTS；原始 17.100 与 17.619 秒之间没有独立帧，不作更细时序声明。VFR 不通过复制帧变成高帧率证明。

`verify_motion.py` 已实跑失败；目前还消费 `real-send-state.json`、检查短输入 Composer 高度和回复到 Composer 的间距。此脚本仍不代替逐帧观察。基线真实上下文为 message75 answeredDirectly、28票、无 open 票、无显式历史查看，因此应无子代理卡；不是以「票没增加」作为通用规则。

## r1 设备复测

- 已同签覆盖红米，SHA256 `382481f1e99e41d3a2e171e010fccc446f23ae2ad019482a7c03f70375ebd6b6`，firstInstallTime 保持 2026-11-11 18:15:06，未清数据。
- `capture-r1/pure-send.mp4` 为35秒纯操作录像，关键阶段没有 uiautomator 轮询。`pure-events.json` 的主机操作时钟与视频起点不是同一时钟，不用于精确逐帧时间换算。
- 真实发送 message76、reply62；已用 look_video 看0–24秒。普通短聊没有再出现无关代理卡；仍有 IME 顶栏问题和消息操作行高度问题，r1 不作最终交付。
- 直接截图 `capture-r1/ime-open.png` 显示 main/menu 被移出屏幕，顶部是裁切的历史消息。
- 实际 WM App 窗口 `mAttrs` 为 `adjust=pan forwardNavigation`，frame/display/parent 均为 `[0,0][1440,3200]`。因此 XML root2049 是可见裁剪，不是实际窗口 resize。记录已只保留本 App 窗口，见 `capture-r1/window-ime.txt`。
- 用户消息的撤回/插话 TextButton 占48dp，动作消失后只余10.5sp状态文字，会改变行高；已要求浮层上下文操作，不用永久48dp空白占位。

## 已发回 r2 的源码问题

1. Native窗口/insets统一归属，IME前后顶栏留在屏内且位置稳定，输入区紧贴键盘，不双算底部导航。
2. 用户消息操作不参与消息布局测量，权威queued/requestId权限与失败反馈保留；未知状态使用中性已发送，不反复卸载状态行。
3. 未知与已知空产出不生成临时隐藏结果行；已有非空产出刷新持续显示。
4. 子代理树仅在真实后代非空时创建可展开卡；未知不画假卡，失败保留明确重试出口。不能仅靠过滤open票掩盖真实open票的unknown路径。
5. 真实已展开查看跨刷新、列表回收和任务终态保持；不复制业务状态。

Android源码由 luna-app 独占；OpenConsole DeepSeek 的 ds-motion-review 独立审查与单独帧锚点验证脚本，lead执行设备与最终视频验收。后台 mDNS睡眠恢复异常单独待修，本轮不把它算作完成项。

## 当前集成收口

R4同签安装与JDK21全量JVM/release构建通过。lead补齐按工单保存读取错误、cache.start失败时不清错误、IME视口变化沿用阅读意图，以及真实结果行变更的跟随通知。真实已可见reply65在打开IME后仍在屏内，gap76px；历史阅读锚点保持 `[177,546][1387,798]`。纯操作357帧与完整录屏443帧固定菜单ROI验证通过；结构验证通过。当前版本详情独立写在 `acceptance-current.md`，不以终态截图代替全过程。

OpenConsole DS的预审意见已用于约束证据。两次额外最终只读复审未返回结果，已停止，不列为审查通过；最终源码检查、JVM与真实录像由lead完成。

运行管理：宿主7200秒caffeinate已自然结束并收集，补充1800秒作业 `bash-5a5bdc5458874413` 已停止并收集；重复唤醒按键作业已停止。红米临时USB保持唤醒值2已恢复原值0，见 `device-test-power.json`。本轮录屏进程已结束、对应远端MP4已取回移除、已知临时XML清理；另一台未操作。

实现与验收目标已经达到；goal `goal-eb162aed-df0b-4473-a1cc-0f46973c79d4` revision3 的工具元数据仍active/disarmed：complete调用因当前为子成员回调回合，被运行时以“require a direct human turn or current goal round”阻止，未改存储绕过。它处于disarmed不会继续自动执行；下一次直接人类回合可补标记。mDNS后台睡眠恢复问题仍是独立待办。
