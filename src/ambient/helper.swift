/**
 * ctxhelper — tiny native helper for Context Autopilot's ambient observer.
 * Compiled on demand by helper.ts (swiftc ships with Xcode CLT). Everything
 * here runs 100% on-device; nothing touches the network.
 *
 *   ctxhelper ocr <image>              print recognized text lines (Apple Vision)
 *   ctxhelper perm screen              print "granted" | "denied" (Screen Recording)
 *   ctxhelper keycount                 print "<keyDowns> <clicks>" (cumulative COUNTS only, never content)
 *   ctxhelper fixture <out.png> <title> <line>…   render a fake-app screenshot for tests/demo
 */

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func loadCGImage(_ path: String) -> CGImage {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { fail("could not read image: \(path)") }
  return image
}

func runOcr(_ path: String) {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: loadCGImage(path), options: [:])
  do { try handler.perform([request]) } catch { fail("vision error: \(error.localizedDescription)") }
  for observation in request.results ?? [] {
    if let candidate = observation.topCandidates(1).first {
      print(candidate.string)
    }
  }
}

/// Print cumulative COUNTS of key-downs and mouse clicks this login session —
/// a typing/activity cadence signal only. Never the keys themselves: the OS
/// exposes just an integer tally via CGEventSource, so there is nothing here
/// that could reconstruct what was typed.
func runKeyCount() {
  let keys = CGEventSource.counterForEventType(.combinedSessionState, eventType: .keyDown)
  let clicks = CGEventSource.counterForEventType(.combinedSessionState, eventType: .leftMouseDown)
  print("\(keys) \(clicks)")
}

func runPerm(_ what: String) {
  switch what {
  case "screen":
    // Preflight never prompts; it just reports the current grant.
    print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
  default:
    fail("unknown permission: \(what)")
  }
}

/// Render a plausible fake-app window screenshot: dark chrome bar with the
/// title, light body with text lines. Gives Vision OCR real pixels to chew on
/// in tests and the demo without needing any capture permissions.
func runFixture(_ out: String, _ title: String, _ lines: [String]) {
  let width = 1200, height = 800
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
  else { fail("could not create bitmap") }

  NSGraphicsContext.saveGraphicsState()
  guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { fail("no graphics context") }
  NSGraphicsContext.current = ctx

  // Body
  NSColor(calibratedWhite: 0.98, alpha: 1).setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()
  // Title bar
  NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.12, alpha: 1).setFill()
  NSRect(x: 0, y: height - 64, width: width, height: 64).fill()

  let titleAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.boldSystemFont(ofSize: 26),
    .foregroundColor: NSColor.white,
  ]
  (title as NSString).draw(at: NSPoint(x: 28, y: CGFloat(height - 48)), withAttributes: titleAttrs)

  let bodyAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 24),
    .foregroundColor: NSColor(calibratedWhite: 0.12, alpha: 1),
  ]
  var y = CGFloat(height - 130)
  for line in lines {
    (line as NSString).draw(at: NSPoint(x: 40, y: y), withAttributes: bodyAttrs)
    y -= 44
    if y < 20 { break }
  }

  NSGraphicsContext.current = nil
  NSGraphicsContext.restoreGraphicsState()

  guard let png = rep.representation(using: .png, properties: [:]) else { fail("could not encode png") }
  do { try png.write(to: URL(fileURLWithPath: out)) } catch { fail("could not write \(out): \(error.localizedDescription)") }
}

/// Render the app icon: the product's teal eye on a dark rounded square
/// (matches the thecontextlayer.ai palette). 1024px master; the builder
/// scales it down and packs an .icns.
func runAppIcon(_ out: String) {
  let size = 1024
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
  else { fail("could not create bitmap") }
  NSGraphicsContext.saveGraphicsState()
  guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { fail("no graphics context") }
  NSGraphicsContext.current = ctx

  // Dark navy rounded square (Big Sur-style inset).
  let inset = CGFloat(size) * 0.09
  let rect = NSRect(x: inset, y: inset, width: CGFloat(size) - 2 * inset, height: CGFloat(size) - 2 * inset)
  let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.22, yRadius: rect.width * 0.22)
  NSColor(calibratedRed: 0.051, green: 0.106, blue: 0.165, alpha: 1).setFill() // #0d1b2a
  path.fill()

  // Teal eye, centered.
  let config = NSImage.SymbolConfiguration(pointSize: CGFloat(size) * 0.42, weight: .semibold)
  if let eye = NSImage(systemSymbolName: "eye.fill", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
    let teal = NSColor(calibratedRed: 0.0, green: 0.784, blue: 0.627, alpha: 1) // #00c8a0
    let tinted = NSImage(size: eye.size)
    tinted.lockFocus()
    teal.set()
    let r = NSRect(origin: .zero, size: eye.size)
    eye.draw(in: r)
    r.fill(using: .sourceAtop)
    tinted.unlockFocus()
    let drawRect = NSRect(
      x: (CGFloat(size) - eye.size.width) / 2,
      y: (CGFloat(size) - eye.size.height) / 2,
      width: eye.size.width, height: eye.size.height)
    tinted.draw(in: drawRect)
  }

  NSGraphicsContext.current = nil
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { fail("could not encode png") }
  do { try png.write(to: URL(fileURLWithPath: out)) } catch { fail("could not write \(out)") }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "ocr" where args.count == 2:
  runOcr(args[1])
case "perm" where args.count == 2:
  runPerm(args[1])
case "keycount":
  runKeyCount()
case "appicon" where args.count == 2:
  runAppIcon(args[1])
case "fixture" where args.count >= 4:
  runFixture(args[1], args[2], Array(args.dropFirst(3)))
default:
  fail("usage: ctxhelper ocr <image> | perm screen | keycount | fixture <out.png> <title> <line>…")
}
