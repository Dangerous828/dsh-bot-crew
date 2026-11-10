import AppKit
import ScreenCaptureKit
_ = NSApplication.shared

// 只截指定窗口，不用整屏，也不抢焦点。
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/desktop-window.png"
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    // onScreenWindowsOnly: false 才能拿到最小化/被遮住的窗口。
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let target = content.windows.first {
      ($0.owningApplication?.applicationName ?? "").lowercased().contains("crew")
        && $0.frame.width > 800 && $0.frame.height > 400
    }
    guard let w = target else { print("no window"); exit(1) }
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let cfg = SCStreamConfiguration()
    cfg.width = Int(w.frame.width * 2)
    cfg.height = Int(w.frame.height * 2)
    cfg.showsCursor = false
    // captureImage 是单张截图，不启动流 —— 不走 -3811 那条路。
    let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let rep = NSBitmapImageRep(cgImage: img)
    if let d = rep.representation(using: .png, properties: [:]) {
      try d.write(to: URL(fileURLWithPath: out))
      print("saved \(d.count) bytes \(img.width)x\(img.height)")
    }
    sem.signal()
  } catch { print("err \(error)"); sem.signal() }
}
sem.wait()
