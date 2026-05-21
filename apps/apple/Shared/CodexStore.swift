import Combine
import Foundation

@MainActor
final class CodexStore: ObservableObject {
    @Published var baseURL: String {
        didSet { defaults.set(baseURL, forKey: Keys.baseURL) }
    }
    @Published var token: String {
        didSet { defaults.set(token, forKey: Keys.token) }
    }
    @Published var selectedProjectName: String {
        didSet { defaults.set(selectedProjectName, forKey: Keys.selectedProjectName) }
    }
    @Published private(set) var projects: [CodexProject] = []
    @Published private(set) var sessions: [CodexSession] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.baseURL = defaults.string(forKey: Keys.baseURL) ?? "http://127.0.0.1:8787"
        self.token = defaults.string(forKey: Keys.token) ?? ""
        self.selectedProjectName = defaults.string(forKey: Keys.selectedProjectName) ?? ""
    }

    var selectedProject: CodexProject? {
        if selectedProjectName.isEmpty { return projects.first }
        return projects.first { $0.name == selectedProjectName } ?? projects.first
    }

    func refresh() async {
        guard let client = makeClient() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let fetchedProjects = client.projects()
            async let fetchedSessions = client.sessions()
            projects = try await fetchedProjects
            sessions = try await fetchedSessions
            if selectedProjectName.isEmpty, let first = projects.first {
                selectedProjectName = first.name
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createSession(prompt: String) async -> CodexSession? {
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanPrompt.isEmpty, let client = makeClient() else { return nil }
        do {
            let session = try await client.createSession(prompt: cleanPrompt, cwd: selectedProject?.name)
            upsert(session)
            errorMessage = nil
            return session
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func reply(threadId: String, text: String) async {
        let cleanText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanText.isEmpty, let client = makeClient() else { return }
        do {
            upsert(try await client.reply(threadId: threadId, text: cleanText))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func interrupt(threadId: String) async {
        guard let client = makeClient() else { return }
        do {
            upsert(try await client.interrupt(threadId: threadId))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshSession(threadId: String) async {
        guard let client = makeClient() else { return }
        do {
            upsert(try await client.session(threadId: threadId))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func makeClient() -> CodexAPIClient? {
        do {
            return try CodexAPIClient(baseURLString: baseURL, token: token)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func upsert(_ session: CodexSession) {
        if let index = sessions.firstIndex(where: { $0.threadId == session.threadId }) {
            sessions[index] = session
        } else {
            sessions.insert(session, at: 0)
        }
        sessions.sort { $0.updatedAt > $1.updatedAt }
    }
}

private enum Keys {
    static let baseURL = "codex.baseURL"
    static let token = "codex.token"
    static let selectedProjectName = "codex.selectedProjectName"
}
