import SwiftUI

@main
struct CodexSyncWatchApp: App {
    @StateObject private var store = CodexStore()

    var body: some Scene {
        WindowGroup {
            WatchContentView()
                .environmentObject(store)
        }
    }
}
