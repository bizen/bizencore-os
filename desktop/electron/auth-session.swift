import AppKit
import AuthenticationServices
import Foundation
import Darwin

struct Request: Decodable { let url: String; let callbackScheme: String; let clerkHost: String }

#if DESKTOP_PRODUCTION
let expectedScheme = "bizencore-terminal"
let expectedClerkHost = "clerk.bizencore.com"
let authenticationTitle = "bizencore terminal - Sign in"
#else
let expectedScheme = "bizencore-electron-preview"
let expectedClerkHost = "grown-gorilla-52.clerk.accounts.dev"
let authenticationTitle = "bizencore Electron Preview - Sign in"
#endif

final class AuthenticationSession: NSObject, ASWebAuthenticationPresentationContextProviding, NSWindowDelegate {
    private var session: ASWebAuthenticationSession?
    private let anchor = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 130), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    private var finished = false
    private var termination: DispatchSourceSignal?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }

    func startAuthentication() {
        anchor.isReleasedWhenClosed = false
        signal(SIGTERM, SIG_IGN)
        termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination?.setEventHandler {
            self.session?.cancel()
            self.finish(nil)
        }
        termination?.resume()
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 32768 else { finish(nil); return }
            let request = try JSONDecoder().decode(Request.self, from: data)
            guard let url = URL(string: request.url), url.scheme == "https",
                  url.user == nil, url.password == nil, url.port == nil,
                  request.callbackScheme == expectedScheme, request.clerkHost == expectedClerkHost,
                  url.host == expectedClerkHost || url.host == "accounts.google.com" else { finish(nil); return }
            presentAuthenticationWindow()
            session = ASWebAuthenticationSession(url: url, callbackURLScheme: request.callbackScheme) { callback, error in
                let code = (error as NSError?)?.code
                DispatchQueue.main.async { self.finish(callback, errorCode: code) }
            }
            session?.presentationContextProvider = self
            session?.prefersEphemeralWebBrowserSession = false
            guard session?.start() == true else { finish(nil, errorCode: -1); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
                self.session?.cancel()
                self.finish(nil)
            }
        } catch { finish(nil) }
    }

    private func presentAuthenticationWindow() {
        anchor.title = authenticationTitle
        anchor.delegate = self
        let status = NSTextField(wrappingLabelWithString: "Waiting for browser sign-in...")
        status.frame = NSRect(x: 24, y: 65, width: 312, height: 40)
        anchor.contentView?.addSubview(status)
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelAuthentication))
        cancel.frame = NSRect(x: 240, y: 20, width: 96, height: 32)
        anchor.contentView?.addSubview(cancel)
        anchor.center()
        anchor.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @objc private func cancelAuthentication() {
        session?.cancel()
        finish(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        cancelAuthentication()
        return false
    }

    private func finish(_ callback: URL?, errorCode: Int? = nil) {
        guard !finished else { return }
        finished = true
        if let callback = callback,
           let data = try? JSONSerialization.data(withJSONObject: ["callbackUrl": callback.absoluteString]) {
            FileHandle.standardOutput.write(data)
        } else if let code = errorCode,
                  let data = try? JSONSerialization.data(withJSONObject: ["errorCode": code]) {
            FileHandle.standardOutput.write(data)
        }
        anchor.close()
        NSApplication.shared.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AuthenticationSession()
app.setActivationPolicy(.accessory)
DispatchQueue.main.async { delegate.startAuthentication() }
app.run()
