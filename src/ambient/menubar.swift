/**
 * ctxmenubar — Context Autopilot's macOS app.
 *
 * Two faces, one binary:
 *  - A menu bar NSStatusItem whose color reflects observation state, with a
 *    menu to toggle recording, pause, or open the app — no terminal needed.
 *  - A real application window (WKWebView rendering the local dashboard) so
 *    the product lives in its own app, not a browser tab. The dock icon
 *    appears only while the window is open (.regular ↔ .accessory dance).
 *
 * It talks to the observer purely through files under ~/.ctxlayer/ambient:
 * reads config.json + heartbeat for state, writes config.json to toggle/pause
 * (the observer re-reads config every tick). 100% local, no network beyond
 * localhost.
 *
 * Idempotent: a pid lock means launching it twice is a no-op; a second launch
 * signals the running instance (file flag) to bring the window forward.
 */

import AppKit
import Darwin
import Foundation
import WebKit

let home = ProcessInfo.processInfo.environment["CTXLAYER_HOME"] ?? (NSHomeDirectory() + "/.ctxlayer")
let ambientDir = home + "/ambient"
let configPath = ambientDir + "/config.json"
let heartbeatPath = ambientDir + "/heartbeat"
let pidPath = ambientDir + "/menubar.pid"
let showWindowFlagPath = ambientDir + "/show-window"
let offersPath = ambientDir + "/offers.jsonl"
let statePath = ambientDir + "/state.json"

/// A Live Assist offer waiting for the user.
struct PendingOffer {
  let id: String
  let goal: String
  let offer: String
}

/// Local calendar day for an ISO timestamp — offers are stamped in UTC, so
/// comparing raw date strings hides anything made after ~8pm local.
private func isToday(_ iso: String) -> Bool {
  let fmt = ISO8601DateFormatter()
  fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  guard let date else { return false }
  return Calendar.current.isDateInToday(date)
}

/// The newest offer from today that the user hasn't dismissed.
func newestPendingOffer() -> PendingOffer? {
  guard let text = try? String(contentsOfFile: offersPath, encoding: .utf8) else { return nil }
  var declined: Set<String> = []
  if let data = FileManager.default.contents(atPath: statePath),
     let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
    let day = obj["declinedAssistDay"] as? String
    let today = DateFormatter()
    today.dateFormat = "yyyy-MM-dd"
    if day == today.string(from: Date()), let keys = obj["declinedAssistKeys"] as? [String] {
      declined = Set(keys)
    }
  }
  for line in text.split(separator: "\n").reversed() {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let at = obj["at"] as? String, isToday(at),
          let id = obj["id"] as? String,
          let goal = obj["goal"] as? String,
          let offer = obj["offer"] as? String else { continue }
    if let key = obj["goalKey"] as? String, declined.contains(key) { continue }
    return PendingOffer(id: id, goal: goal, offer: offer)
  }
  return nil
}

enum ObserveState { case observing, paused, off }

func readConfig() -> [String: Any] {
  guard let data = FileManager.default.contents(atPath: configPath),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return [:] }
  return obj
}

func writeConfig(_ mutate: (inout [String: Any]) -> Void) {
  var c = readConfig()
  c["version"] = 1
  mutate(&c)
  try? FileManager.default.createDirectory(atPath: ambientDir, withIntermediateDirectories: true)
  if let data = try? JSONSerialization.data(withJSONObject: c, options: [.prettyPrinted, .sortedKeys]) {
    try? data.write(to: URL(fileURLWithPath: configPath))
  }
}

func observerAlive() -> Bool {
  guard let attrs = try? FileManager.default.attributesOfItem(atPath: heartbeatPath),
        let modified = attrs[.modificationDate] as? Date
  else { return false }
  return Date().timeIntervalSince(modified) < 12 // heartbeat every 2s, generous grace
}

func currentState() -> ObserveState {
  let c = readConfig()
  let enabled = (c["enabled"] as? Bool) ?? true
  if !enabled { return .off }
  if let until = c["pausedUntil"] as? String {
    // config timestamps are ISO-8601 Z; lexical compare matches the TS side.
    if until > ISO8601DateFormatter().string(from: Date()) { return .paused }
  }
  return observerAlive() ? .observing : .off
}

func dashboardPort() -> Int {
  return (readConfig()["dashboardPort"] as? Int) ?? 4780
}

func dashboardURL() -> URL {
  return URL(string: "http://localhost:\(dashboardPort())/")!
}

func alreadyRunning() -> Bool {
  guard let s = try? String(contentsOfFile: pidPath, encoding: .utf8),
        let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines))
  else { return false }
  return kill(pid, 0) == 0 // signal 0 just probes existence
}

// ---------------------------------------------------------------------------
// The application window: the dashboard in its own native shell.

final class DashboardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  private var window: NSWindow?
  private var webView: WKWebView?
  private var retryTimer: Timer?
  var onWindowClosed: (() -> Void)?
  var startObserver: (() -> Void)?

  func show() {
    if let w = window {
      w.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = false
    web.underPageBackgroundColor = NSColor(calibratedRed: 0.039, green: 0.055, blue: 0.078, alpha: 1) // #0a0e14

    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    w.title = "Context Autopilot"
    w.minSize = NSSize(width: 980, height: 640)
    w.appearance = NSAppearance(named: .darkAqua) // match the dashboard's palette
    w.backgroundColor = web.underPageBackgroundColor
    w.contentView = web
    w.delegate = self
    w.isReleasedWhenClosed = false
    w.setFrameAutosaveName("ai.thecontextlayer.autopilot.window")
    if w.frame.width < 100 { w.center() } // first launch: no saved frame yet

    window = w
    webView = web
    load()
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  var isVisible: Bool { return window?.isVisible ?? false }

  private func load() {
    webView?.load(URLRequest(url: dashboardURL(), cachePolicy: .reloadIgnoringLocalCacheData))
  }

  // Dashboard not up yet (fresh boot, daemon starting): show a quiet holding
  // page, nudge the observer, and retry every 2s until the real page loads.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    startObserver?()
    let html = """
    <!doctype html><meta charset="utf-8"><body style="background:#0a0e14;color:#8b97ad;\
    font:15px -apple-system;display:flex;align-items:center;justify-content:center;height:96vh">\
    <div style="text-align:center"><div style="font-size:34px">👁</div>\
    <p>Starting the observer…</p></div></body>
    """
    webView.loadHTMLString(html, baseURL: nil)
    retryTimer?.invalidate()
    retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.load() }
  }

  // The dashboard's JS uses alert()/confirm() (e.g. the Delete confirmation).
  // WKWebView swallows both unless the host implements them — do it natively.
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = "Context Autopilot"
    alert.informativeText = message
    alert.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = "Context Autopilot"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }

  func windowWillClose(_ notification: Notification) {
    retryTimer?.invalidate()
    onWindowClosed?()
  }
}

// ---------------------------------------------------------------------------
// Main menu — an LSUIElement app has none, but the window's text fields need
// ⌘C/⌘V/⌘X/⌘A, and the window itself deserves ⌘W. Standard selectors only.

func installMainMenu() {
  let main = NSMenu()

  let appItem = NSMenuItem()
  main.addItem(appItem)
  let appMenu = NSMenu()
  appMenu.addItem(NSMenuItem(title: "Hide Context Autopilot", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
  appMenu.addItem(.separator())
  appMenu.addItem(NSMenuItem(title: "Quit Context Autopilot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
  appItem.submenu = appMenu

  let editItem = NSMenuItem()
  main.addItem(editItem)
  let edit = NSMenu(title: "Edit")
  edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
  edit.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
  edit.addItem(.separator())
  edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
  edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
  edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
  edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
  editItem.submenu = edit

  let windowItem = NSMenuItem()
  main.addItem(windowItem)
  let win = NSMenu(title: "Window")
  win.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
  win.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
  windowItem.submenu = win

  NSApp.mainMenu = main
}

// ---------------------------------------------------------------------------

final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate, NSUserNotificationCenterDelegate {
  var item: NSStatusItem!
  let dashboard = DashboardWindow()
  /// Self-healing throttle: don't hammer the start script if it keeps failing
  /// (e.g. permissions revoked) — one attempt per 30s is plenty.
  var lastReviveAttempt = Date.distantPast
  /// The Live Assist offer currently waiting (drives the icon badge + menu).
  var pendingOffer: PendingOffer?
  /// Last offer we posted a banner for, so a pending offer notifies once.
  var lastNotifiedOfferId: String?

  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // Persist position across launches so the user can ⌘-drag the icon to a
    // spot they like (e.g. out from under a notch) and have it stay put.
    item.autosaveName = "ai.thecontextlayer.autopilot.status"
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    installMainMenu()

    // Dock icon only while the window is open; menu-bar-only otherwise.
    dashboard.onWindowClosed = { NSApp.setActivationPolicy(.accessory) }
    dashboard.startObserver = { [weak self] in self?.startObserverIfDead() }

    // If observation is meant to be on but no daemon is alive, revive it —
    // opening the app should mean observing, with zero extra steps.
    if (readConfig()["enabled"] as? Bool) ?? true { startObserverIfDead() }
    refreshIcon()
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      self?.consumeShowWindowFlag()
      self?.selfHeal()
      self?.refreshIcon()
      self?.checkForOffers()
    }
    // Opening the app should SHOW the app. Give the dashboard a beat to come
    // up (the daemon may have just been revived), then present the window.
    if userLaunched {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.showWindow() }
    }
  }

  func showWindow() {
    NSApp.setActivationPolicy(.regular) // real app: dock icon, ⌘Tab presence
    dashboard.show()
  }

  /// A second launch (Spotlight/Finder while we're running) can't reach this
  /// process directly — it touches a flag file; we consume it here.
  func consumeShowWindowFlag() {
    guard FileManager.default.fileExists(atPath: showWindowFlagPath) else { return }
    try? FileManager.default.removeItem(atPath: showWindowFlagPath)
    showWindow()
  }

  /// Surface a new Live Assist offer from THIS app.
  ///
  /// The observer used to post these through osascript, which macOS attributes
  /// to Script Editor — so the alert looked like it came from a scripting tool,
  /// its text was clipped, and clicking it opened Script Editor's file dialog
  /// instead of the offer. Posting from the real bundle fixes the identity, and
  /// the badge + menu item mean the offer is reachable even if the banner is
  /// missed entirely.
  func checkForOffers() {
    guard let offer = newestPendingOffer() else {
      if pendingOffer != nil { pendingOffer = nil; refreshIcon() }
      return
    }
    let isNew = offer.id != pendingOffer?.id
    pendingOffer = offer
    guard isNew, offer.id != lastNotifiedOfferId else { return }
    lastNotifiedOfferId = offer.id
    refreshIcon()
    postOfferNotification(offer)
  }

  private func postOfferNotification(_ offer: PendingOffer) {
    let note = NSUserNotification()
    note.title = "Context Autopilot can help"
    // Subtitle carries the goal; the body carries the offer. Banners clip long
    // text, so the menu bar and dashboard hold the full version.
    note.subtitle = offer.goal
    note.informativeText = offer.offer
    note.hasActionButton = true
    note.actionButtonTitle = "Review"
    note.soundName = nil
    NSUserNotificationCenter.default.delegate = self
    NSUserNotificationCenter.default.deliver(note)
  }

  func userNotificationCenter(_ center: NSUserNotificationCenter, didActivate note: NSUserNotification) {
    // Any click — banner or action button — opens the app on the offer.
    showWindow()
  }

  func userNotificationCenter(_ center: NSUserNotificationCenter, shouldPresent note: NSUserNotification) -> Bool {
    true // show even when we're the frontmost app
  }

  func refreshIcon() {
    guard let button = item.button else { return }
    let state = currentState()
    let symbol: String
    let color: NSColor
    switch state {
    case .observing: symbol = "eye.fill"; color = .systemGreen
    case .paused: symbol = "pause.circle.fill"; color = .systemYellow
    case .off: symbol = "eye.slash"; color = .systemGray
    }
    // A waiting offer overrides the state colour: the icon is the one thing
    // always on screen, so it's where "something needs you" belongs.
    if pendingOffer != nil {
      let bulb = NSImage(systemSymbolName: "lightbulb.fill", accessibilityDescription: "Context Autopilot — help available")
      bulb?.isTemplate = true
      button.image = bulb
      button.contentTintColor = .systemYellow
      return
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Context Autopilot")
    image?.isTemplate = true
    button.image = image
    button.contentTintColor = color
  }

  // The user clicked the app while it's already running (Dock/Spotlight/Finder):
  // bring the window forward. This is what makes clicking always do something.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    startObserverIfDead()
    showWindow()
    return true
  }

  // Rebuild the menu each time it opens, so labels match the live state.
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let state = currentState()
    let header: String
    switch state {
    case .observing: header = "● Observing"
    case .paused: header = "❚❚ Paused"
    case .off: header = "○ Observation off"
    }
    let head = NSMenuItem(title: "Context Autopilot — \(header)", action: nil, keyEquivalent: "")
    head.isEnabled = false
    menu.addItem(head)
    menu.addItem(.separator())

    // A waiting offer goes at the top, with the full text a banner can't fit.
    if let offer = pendingOffer {
      let title = NSMenuItem(title: "💡 \(clip(offer.goal, 60))", action: nil, keyEquivalent: "")
      title.isEnabled = false
      menu.addItem(title)
      for line in wrap(offer.offer, width: 58) {
        let detail = NSMenuItem(title: "   \(line)", action: nil, keyEquivalent: "")
        detail.isEnabled = false
        menu.addItem(detail)
      }
      add(menu, "   Review and accept →", #selector(openWindow))
      add(menu, "   Not now", #selector(dismissOffer))
      menu.addItem(.separator())
    }

    if state == .off {
      add(menu, "Turn observation on", #selector(turnOn))
    } else {
      add(menu, "Turn observation off", #selector(turnOff))
      add(menu, "Pause for 30 minutes", #selector(pause30))
    }
    menu.addItem(.separator())
    add(menu, "Open Context Autopilot", #selector(openWindow))
    add(menu, "Open in browser", #selector(openInBrowser))
    menu.addItem(.separator())
    add(menu, "Quit menu bar app", #selector(quitApp), key: "q")
  }

  private func clip(_ text: String, _ max: Int) -> String {
    text.count <= max ? text : String(text.prefix(max - 1)) + "…"
  }

  /// Wrap on word boundaries so a long offer reads as a few menu lines.
  private func wrap(_ text: String, width: Int) -> [String] {
    var lines: [String] = []
    var current = ""
    for word in text.split(separator: " ") {
      if current.isEmpty { current = String(word) }
      else if current.count + 1 + word.count <= width { current += " " + word }
      else { lines.append(current); current = String(word) }
      if lines.count == 4 { break } // a menu is not a document
    }
    if !current.isEmpty && lines.count < 4 { lines.append(current) }
    return lines
  }

  /// "Not now" from the menu bar — same suppression the dashboard button uses.
  @objc func dismissOffer() {
    guard let offer = pendingOffer else { return }
    let port = (readConfig()["dashboardPort"] as? Int) ?? 4780
    guard let url = URL(string: "http://127.0.0.1:\(port)/api/assist/dismiss") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // The dashboard dismisses by goalKey; re-read it for this offer id.
    var goalKey = ""
    if let text = try? String(contentsOfFile: offersPath, encoding: .utf8) {
      for line in text.split(separator: "\n").reversed() {
        if let data = line.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           obj["id"] as? String == offer.id, let key = obj["goalKey"] as? String { goalKey = key; break }
      }
    }
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["goalKey": goalKey])
    URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
      DispatchQueue.main.async { self?.pendingOffer = nil; self?.refreshIcon() }
    }.resume()
  }

  private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") {
    let mi = NSMenuItem(title: title, action: action, keyEquivalent: key)
    mi.target = self
    menu.addItem(mi)
  }

  @objc func turnOn() {
    writeConfig { c in c["enabled"] = true; c.removeValue(forKey: "pausedUntil") }
    startObserverIfDead()
    refreshIcon()
  }

  /// Self-healing: observation is meant to be ON but the daemon's heartbeat is
  /// stale (crash, force-quit, failed login start) → revive it automatically.
  /// No human should have to notice a dead observer.
  func selfHeal() {
    guard (readConfig()["enabled"] as? Bool) ?? true else { return }
    guard !observerAlive() else { return }
    guard Date().timeIntervalSince(lastReviveAttempt) > 30 else { return }
    lastReviveAttempt = Date()
    startObserverIfDead()
  }

  /// Revive a dead observer via the start script the CLI keeps fresh —
  /// so the menu bar toggle genuinely means "observing", not just a config bit.
  func startObserverIfDead() {
    if observerAlive() { return }
    let script = home + "/bin/start-observer.sh"
    guard FileManager.default.isExecutableFile(atPath: script) else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: script)
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
  }
  @objc func turnOff() {
    writeConfig { c in c["enabled"] = false }
    refreshIcon()
  }
  @objc func pause30() {
    let until = ISO8601DateFormatter().string(from: Date().addingTimeInterval(30 * 60))
    writeConfig { c in c["pausedUntil"] = until }
    refreshIcon()
  }
  @objc func openWindow() {
    showWindow()
  }
  @objc func openInBrowser() {
    NSWorkspace.shared.open(dashboardURL())
  }
  @objc func quitApp() {
    try? FileManager.default.removeItem(atPath: pidPath)
    NSApp.terminate(nil)
  }
}

// Distinguish "user opened the app" from "the daemon spawned me in the
// background". bundleIdentifier is only set when running as the .app bundle
// executable — so that (or an explicit flag) means show the window; a bare
// binary spawned by the observer stays quiet and just shows the icon.
let userLaunched = Bundle.main.bundleIdentifier != nil || CommandLine.arguments.contains("--open-dashboard")

// A second instance (user clicked the app while one's already running) still
// honors the intent: signal the live instance to present the window, step aside.
if alreadyRunning() {
  if userLaunched {
    try? Data().write(to: URL(fileURLWithPath: showWindowFlagPath))
  }
  exit(0)
}
try? FileManager.default.createDirectory(atPath: ambientDir, withIntermediateDirectories: true)
try? "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: pidPath, atomically: true, encoding: .utf8)

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only until the window opens
let controller = MenuController()
app.delegate = controller
app.run()
