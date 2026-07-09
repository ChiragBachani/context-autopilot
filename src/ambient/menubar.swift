/**
 * ctxmenubar — Context Autopilot's macOS menu bar app.
 *
 * A tiny NSStatusItem agent (no dock icon) that lives in the top bar alongside
 * the system icons. Its color reflects observation state, and its menu lets you
 * toggle recording, pause, or open the dashboard — without a terminal.
 *
 * It talks to the observer purely through files under ~/.ctxlayer/ambient:
 * reads config.json + heartbeat for state, writes config.json to toggle/pause
 * (the observer re-reads config every tick). 100% local, no network.
 *
 * Idempotent: a pid lock means launching it twice is a no-op, so `observe`
 * can spawn it freely.
 */

import AppKit
import Darwin
import Foundation

let home = ProcessInfo.processInfo.environment["CTXLAYER_HOME"] ?? (NSHomeDirectory() + "/.ctxlayer")
let ambientDir = home + "/ambient"
let configPath = ambientDir + "/config.json"
let heartbeatPath = ambientDir + "/heartbeat"
let pidPath = ambientDir + "/menubar.pid"

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

func alreadyRunning() -> Bool {
  guard let s = try? String(contentsOfFile: pidPath, encoding: .utf8),
        let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines))
  else { return false }
  return kill(pid, 0) == 0 // signal 0 just probes existence
}

final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate {
  var item: NSStatusItem!

  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    // If observation is meant to be on but no daemon is alive, revive it —
    // opening the app should mean observing, with zero extra steps.
    if (readConfig()["enabled"] as? Bool) ?? true { startObserverIfDead() }
    refreshIcon()
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refreshIcon() }
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
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Context Autopilot")
    image?.isTemplate = true
    button.image = image
    button.contentTintColor = color
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

    if state == .off {
      add(menu, "Turn observation on", #selector(turnOn))
    } else {
      add(menu, "Turn observation off", #selector(turnOff))
      add(menu, "Pause for 30 minutes", #selector(pause30))
    }
    menu.addItem(.separator())
    add(menu, "Open dashboard", #selector(openDashboard))
    menu.addItem(.separator())
    add(menu, "Quit menu bar app", #selector(quitApp), key: "q")
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
  @objc func openDashboard() {
    if let url = URL(string: "http://localhost:\(dashboardPort())") {
      NSWorkspace.shared.open(url)
    }
  }
  @objc func quitApp() {
    try? FileManager.default.removeItem(atPath: pidPath)
    NSApp.terminate(nil)
  }
}

if alreadyRunning() { exit(0) }
try? FileManager.default.createDirectory(atPath: ambientDir, withIntermediateDirectories: true)
try? "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: pidPath, atomically: true, encoding: .utf8)

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no dock icon
let controller = MenuController()
app.delegate = controller
app.run()
