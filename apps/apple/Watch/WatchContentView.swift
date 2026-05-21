import SwiftUI

struct WatchContentView: View {
    @EnvironmentObject private var store: CodexStore
    @State private var showingNewTask = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                Button {
                    showingNewTask = true
                } label: {
                    Label("New Task", systemImage: "plus.circle.fill")
                }

                if let message = store.errorMessage {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }

                if !needsYouSessions.isEmpty {
                    Section("Needs You") {
                        ForEach(needsYouSessions) { session in
                            NavigationLink(value: session) {
                                WatchSessionRow(session: session)
                            }
                        }
                    }
                }

                if !activeSessions.isEmpty {
                    Section("Active") {
                        ForEach(activeSessions) { session in
                            NavigationLink(value: session) {
                                WatchSessionRow(session: session)
                            }
                        }
                    }
                }

                if !finishedSessions.isEmpty {
                    Section("Done") {
                        ForEach(finishedSessions) { session in
                            NavigationLink(value: session) {
                                WatchSessionRow(session: session)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Codex")
            .navigationDestination(for: CodexSession.self) { session in
                WatchSessionDetailView(session: session)
                    .environmentObject(store)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showingNewTask) {
                WatchNewTaskView()
                    .environmentObject(store)
            }
            .sheet(isPresented: $showingSettings) {
                WatchSettingsView()
                    .environmentObject(store)
            }
            .task {
                await store.refresh()
                await refreshLoop()
            }
        }
    }

    private var needsYouSessions: [CodexSession] {
        store.sessions.filter { CodexSessionStatus($0.status) == .waiting }
    }

    private var activeSessions: [CodexSession] {
        store.sessions.filter {
            ![.waiting, .done, .error, .interrupted].contains(CodexSessionStatus($0.status))
        }
    }

    private var finishedSessions: [CodexSession] {
        store.sessions.filter {
            [.done, .error, .interrupted].contains(CodexSessionStatus($0.status))
        }
    }

    private func refreshLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await store.refresh()
        }
    }
}

struct WatchSessionRow: View {
    var session: CodexSession

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.watchTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 4)
                StatusDot(status: session.status)
            }
            Text(session.riskLabel)
                .font(.caption2.weight(.semibold))
            if !session.latest.isEmpty {
                Text(session.latest)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

struct WatchSessionDetailView: View {
    @EnvironmentObject private var store: CodexStore
    var session: CodexSession
    @State private var reply = ""

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    StatusDot(status: session.status)
                    Text(CodexSessionStatus(session.status).label)
                        .font(.headline)
                }
                if !session.latest.isEmpty {
                    Text(session.latest)
                        .font(.caption)
                }
            }

            if session.pendingApproval != nil {
                Button("Approve") {
                    Task { await store.reply(threadId: session.threadId, text: "Approve") }
                }
                Button("Deny") {
                    Task { await store.reply(threadId: session.threadId, text: "Deny") }
                }
            }

            TextField("Reply", text: $reply)
            Button("Send") {
                let message = reply
                reply = ""
                Task { await store.reply(threadId: session.threadId, text: message) }
            }
            .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if CodexSessionStatus(session.status) == .done {
                Button("Follow Up") {
                    reply = "Follow up: "
                }
            }

            Button("Interrupt", role: .destructive) {
                Task { await store.interrupt(threadId: session.threadId) }
            }

            ForEach(session.events.suffix(5).reversed(), id: \.createdAt) { event in
                Text(event.text)
                    .font(.caption2)
                    .lineLimit(3)
            }
        }
        .navigationTitle(session.watchTitle)
        .task {
            await store.refreshSession(threadId: session.threadId)
        }
    }
}

struct WatchNewTaskView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CodexStore
    @State private var prompt = ""
    @State private var isStarting = false
    @State private var selectedPresetId = TaskPreset.defaults[0].id
    @FocusState private var promptFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                if !store.projects.isEmpty {
                    Picker("Repo", selection: $store.selectedProjectName) {
                        ForEach(store.projects) { project in
                            Text(project.name).tag(project.name)
                        }
                    }
                }

                Picker("Preset", selection: $selectedPresetId) {
                    ForEach(TaskPreset.defaults) { preset in
                        Label(preset.title, systemImage: preset.systemImage)
                            .tag(preset.id)
                    }
                }
                Button("Use Preset") {
                    if let preset = TaskPreset.defaults.first(where: { $0.id == selectedPresetId }) {
                        prompt = preset.prompt
                    }
                }

                TextField("Tell Codex what to do", text: $prompt)
                    .focused($promptFocused)

                Button(isStarting ? "Starting" : "Start") {
                    Task {
                        isStarting = true
                        _ = await store.createSession(prompt: prompt)
                        isStarting = false
                        dismiss()
                    }
                }
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isStarting)
            }
            .navigationTitle("New Task")
            .task {
                if store.projects.isEmpty {
                    await store.refresh()
                }
                promptFocused = true
            }
        }
    }
}

struct WatchSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CodexStore

    var body: some View {
        NavigationStack {
            List {
                TextField("API URL", text: $store.baseURL)
                SecureField("Token", text: $store.token)
                Button("Refresh") {
                    Task { await store.refresh() }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct StatusDot: View {
    var status: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
    }

    private var color: Color {
        switch CodexSessionStatus(status) {
        case .done: .green
        case .error: .red
        case .waiting: .orange
        case .testing: .blue
        case .interrupted: .gray
        default: .primary
        }
    }
}
