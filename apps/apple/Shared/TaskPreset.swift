import Foundation

struct TaskPreset: Identifiable, Hashable {
    var id: String
    var title: String
    var systemImage: String
    var prompt: String

    static let defaults: [TaskPreset] = [
        TaskPreset(
            id: "fix-bug",
            title: "Fix Bug",
            systemImage: "wrench.and.screwdriver",
            prompt: "Investigate and fix the bug. Keep the change focused, run the relevant tests, and summarize the files changed."
        ),
        TaskPreset(
            id: "investigate",
            title: "Investigate",
            systemImage: "magnifyingglass",
            prompt: "Investigate the issue, identify the root cause, and report the smallest safe fix before changing code."
        ),
        TaskPreset(
            id: "review",
            title: "Review PR",
            systemImage: "doc.text.magnifyingglass",
            prompt: "Review the current changes for bugs, regressions, and missing tests. Prioritize concrete findings with file references."
        ),
        TaskPreset(
            id: "run-tests",
            title: "Run Tests",
            systemImage: "checkmark.seal",
            prompt: "Run the relevant test suite, fix any failures caused by this branch, and report the result."
        ),
        TaskPreset(
            id: "ship",
            title: "Ship",
            systemImage: "paperplane",
            prompt: "Prepare this change to ship. Run tests, review the diff, and open a PR if everything is ready."
        )
    ]
}
