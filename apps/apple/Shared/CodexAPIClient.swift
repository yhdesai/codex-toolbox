import Foundation

enum CodexAPIError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Set a valid Codex Watch API URL."
        case .invalidResponse:
            return "The Codex Watch API returned an invalid response."
        case .server(let message):
            return message
        }
    }
}

struct CodexAPIClient {
    var baseURL: URL
    var token: String
    var session: URLSession = .shared

    init(baseURLString: String, token: String) throws {
        guard let url = URL(string: baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw CodexAPIError.invalidBaseURL
        }
        self.baseURL = url
        self.token = token
    }

    func projects() async throws -> [CodexProject] {
        try await get("/watch/projects", as: ProjectsResponse.self).projects
    }

    func sessions() async throws -> [CodexSession] {
        try await get("/watch/sessions", as: SessionsResponse.self).sessions
    }

    func session(threadId: String) async throws -> CodexSession {
        try await get("/watch/sessions/\(threadId.urlPathEscaped)", as: SessionResponse.self).session
    }

    func createSession(prompt: String, cwd: String?, title: String? = nil) async throws -> CodexSession {
        let request = NewSessionRequest(prompt: prompt, cwd: cwd, title: title)
        return try await post("/watch/sessions", body: request, as: SessionResponse.self).session
    }

    func reply(threadId: String, text: String) async throws -> CodexSession {
        let request = ReplyRequest(text: text)
        return try await post("/watch/sessions/\(threadId.urlPathEscaped)/reply", body: request, as: SessionResponse.self).session
    }

    func interrupt(threadId: String) async throws -> CodexSession {
        try await post("/watch/sessions/\(threadId.urlPathEscaped)/interrupt", body: EmptyBody(), as: SessionResponse.self).session
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        var request = URLRequest(url: baseURL.appendingCodexPath(path))
        request.httpMethod = "GET"
        applyHeaders(to: &request)
        return try await send(request, as: type)
    }

    private func post<Body: Encodable, T: Decodable>(_ path: String, body: Body, as type: T.Type) async throws -> T {
        var request = URLRequest(url: baseURL.appendingCodexPath(path))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyHeaders(to: &request)
        return try await send(request, as: type)
    }

    private func applyHeaders(to request: inout URLRequest) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "Authorization")
        }
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CodexAPIError.invalidResponse
        }
        if !(200..<300).contains(http.statusCode) {
            if let error = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw CodexAPIError.server(error.error)
            }
            throw CodexAPIError.server("Request failed with HTTP \(http.statusCode).")
        }
        return try JSONDecoder().decode(type, from: data)
    }
}

private struct EmptyBody: Encodable {}

private extension URL {
    func appendingCodexPath(_ rawPath: String) -> URL {
        var components = URLComponents(url: self, resolvingAgainstBaseURL: false)
        let basePath = components?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
        let nextPath = rawPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components?.path = "/" + [basePath, nextPath].filter { !$0.isEmpty }.joined(separator: "/")
        return components?.url ?? self
    }
}

private extension String {
    var urlPathEscaped: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}
