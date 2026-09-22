import AppKit
import UserNotifications

// A small, background-only app. Node keeps its stdout open; selecting the
// notification prints CLICK so the worker can select the held Chrome tab.
final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if !granted {
                fputs("Notification permission denied: \(error?.localizedDescription ?? "enable NOVUS Operator notifications in System Settings")\n", stderr)
                exit(1)
            }
            let content = UNMutableNotificationContent()
            content.title = "NOVUS operator"
            content.subtitle = CommandLine.arguments.dropFirst().first ?? "Intervention required"
            content.body = CommandLine.arguments.dropFirst(2).first ?? "Open the operator browser"
            content.sound = .default
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request) { error in
                if let error = error {
                    fputs("Notification failed: \(error.localizedDescription)\n", stderr)
                    exit(1)
                }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        print("CLICK")
        fflush(stdout)
        completionHandler()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Notifier()
app.delegate = delegate
app.run()
