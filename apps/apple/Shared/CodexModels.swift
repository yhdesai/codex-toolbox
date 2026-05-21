import Foundation

struct CodexProject: Codable, Identifiable, Hashable {
    var name: String
    var path: String

    var id: String { name }
}

struct CodexSession: Codable, Identifiable, Hashable {
    var threadId: String
    var title: String
    var cwd: String?
    var prompt: String?
    var status: String
    var latest: String
    var createdAt: String
    var updatedAt: String
    var events: [CodexSessionEvent]
    var pendingApproval: CodexPendingApproval?

    var id: String { threadId }
}

struct CodexSessionEvent: Codable, Hashable {
    var type: String
    var text: String
    var createdAt: String
}

struct CodexPendingApproval: Codable, Hashable {
    var id: String
    var method: String
    var summary: String
    var createdAt: String
}

struct ProjectsResponse: Codable {
    var projects: [CodexProject]
}

struct SessionsResponse: Codable {
    var sessions: [CodexSession]
}

struct SessionResponse: Codable {
    var session: CodexSession
}

struct APIErrorResponse: Codable {
    var error: String
}

struct NewSessionRequest: Codable {
    var prompt: String
    var cwd: String?
    var title: String?
}

struct ReplyRequest: Codable {
    var text: String
}

enum CodexSessionStatus: String {
    case starting
    case working
    case editing
    case runningCommand = "running_command"
    case testing
    case waiting
    case done
    case error
    case interrupted
    case unknown

    init(_ rawValue: String) {
        self = CodexSessionStatus(rawValue: rawValue) ?? .unknown
    }

    var label: String {
        switch self {
        case .starting: "Starting"
        case .working, .editing, .runningCommand: "Working"
        case .testing: "Testing"
        case .waiting: "Needs You"
        case .done: "Done"
        case .error: "Failed"
        case .interrupted: "Paused"
        case .unknown: "Unknown"
        }
    }

    var detailLabel: String {
        switch self {
        case .editing: "Editing files"
        case .runningCommand: "Running command"
        case .waiting: "Waiting for your input"
        case .interrupted: "Interrupted"
        default: label
        }
    }
}

extension CodexSession {
    var watchTitle: String {
        title.isEmpty ? "Codex Session" : title
    }

    var riskLabel: String {
        let combined = "\(status) \(latest) \(events.map(\.text).joined(separator: " "))".lowercased()
        if CodexSessionStatus(status) == .error { return "Review needed" }
        if combined.contains("tests passed") || combined.contains("test passed") { return "Tests passed" }
        if combined.contains("tests not run") || combined.contains("not run") { return "Tests not run" }
        if CodexSessionStatus(status) == .done { return "Review summary" }
        return CodexSessionStatus(status).detailLabel
    }
}
