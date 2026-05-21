import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: CodexStore
    @State private var showingNewTask = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            List {
                if let message = store.errorMessage {
                    Section {
                        Text(message)
                            .foregroundStyle(.red)
                    }
                }

                if !needsYouSessions.isEmpty {
                    Section("Needs You") {
                        ForEach(needsYouSessions) { session in
                            NavigationLink(value: session) {
                                SessionRow(session: session)
                            }
                        }
                    }
                }

                if !activeSessions.isEmpty {
                    Section("Active") {
                        ForEach(activeSessions) { session in
                            NavigationLink(value: session) {
                                SessionRow(session: session)
                            }
                        }
                    }
                }

                if !finishedSessions.isEmpty {
                    Section("Finished") {
                        ForEach(finishedSessions) { session in
                            NavigationLink(value: session) {
                                SessionRow(session: session)
                            }
                        }
                    }
                }
            }
            .overlay {
                if store.sessions.isEmpty && !store.isLoading {
                    ContentUnavailableView("No Sessions", systemImage: "apple.terminal", description: Text("Start a Codex session from iPhone or Apple Watch."))
                }
            }
            .navigationTitle("Codex Sync")
            .navigationDestination(for: CodexSession.self) { session in
                SessionDetailView(store: store, session: session)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingNewTask = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .refreshable {
                await store.refresh()
            }
            .task {
                await store.refresh()
            }
            .sheet(isPresented: $showingNewTask) {
                NewTaskView()
                    .environmentObject(store)
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
                    .environmentObject(store)
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
}

struct NewTaskView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CodexStore
    @State private var prompt = ""
    @State private var isStarting = false
    @State private var selectedPresetId = TaskPreset.defaults[0].id

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    Picker("Project", selection: $store.selectedProjectName) {
                        ForEach(store.projects) { project in
                            Text(project.name).tag(project.name)
                        }
                    }
                }

                Section("Preset") {
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
                }

                Section("Prompt") {
                    TextField("What should Codex do?", text: $prompt, axis: .vertical)
                        .lineLimit(4...8)
                }
            }
            .navigationTitle("New Task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
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
            }
            .task {
                if store.projects.isEmpty {
                    await store.refresh()
                }
            }
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: CodexStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    TextField("API URL", text: $store.baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("Token", text: $store.token)
                }

                Section("Projects") {
                    Picker("Default", selection: $store.selectedProjectName) {
                        ForEach(store.projects) { project in
                            Text(project.name).tag(project.name)
                        }
                    }
                    Button("Refresh Projects") {
                        Task { await store.refresh() }
                    }
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
