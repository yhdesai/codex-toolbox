import SwiftUI

@main
struct CodexSyncApp: App {
    @StateObject private var store = CodexStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}
