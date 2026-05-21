import SwiftUI

struct StatusBadge: View {
    var status: String

    var body: some View {
        Text(CodexSessionStatus(status).label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }

    private var background: Color {
        switch CodexSessionStatus(status) {
        case .done: .green.opacity(0.18)
        case .error: .red.opacity(0.18)
        case .waiting: .orange.opacity(0.2)
        case .testing: .blue.opacity(0.18)
        case .interrupted: .gray.opacity(0.18)
        default: .secondary.opacity(0.14)
        }
    }

    private var foreground: Color {
        switch CodexSessionStatus(status) {
        case .done: .green
        case .error: .red
        case .waiting: .orange
        case .testing: .blue
        case .interrupted: .secondary
        default: .primary
        }
    }
}

struct SessionRow: View {
    var session: CodexSession

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.watchTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusBadge(status: session.status)
            }
            if !session.latest.isEmpty {
                Text(session.latest)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text(session.riskLabel)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

struct SessionDetailView: View {
    @ObservedObject var store: CodexStore
    var session: CodexSession
    @State private var reply = ""

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(session.watchTitle)
                            .font(.headline)
                        Spacer()
                        StatusBadge(status: session.status)
                    }
                    if let cwd = session.cwd {
                        Text(cwd)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if !session.latest.isEmpty {
                        Text(session.latest)
                    }
                    Text(session.riskLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let approval = session.pendingApproval {
                Section("Needs Reply") {
                    Text(approval.summary)
                    Button("Approve / Continue") {
                        Task { await store.reply(threadId: session.threadId, text: "Approve") }
                    }
                    Button("Deny") {
                        Task { await store.reply(threadId: session.threadId, text: "Deny") }
                    }
                }
            }

            Section("Reply") {
                TextField("Message Codex", text: $reply, axis: .vertical)
                Button("Send") {
                    let message = reply
                    reply = ""
                    Task { await store.reply(threadId: session.threadId, text: message) }
                }
                .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if CodexSessionStatus(session.status) == .done {
                Section("Follow Up") {
                    Button("Ask for summary") {
                        Task { await store.reply(threadId: session.threadId, text: "Summarize what changed, tests run, and remaining risks.") }
                    }
                    Button("Open follow-up prompt") {
                        reply = "Follow up: "
                    }
                }
            }

            Section("Timeline") {
                ForEach(session.events.indices.reversed(), id: \.self) { index in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.events[index].text)
                        Text(session.events[index].type)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                Button("Interrupt", role: .destructive) {
                    Task { await store.interrupt(threadId: session.threadId) }
                }
            }
        }
        .navigationTitle("Session")
        .task { await store.refreshSession(threadId: session.threadId) }
    }
}
