//! Line counts for the files an agent edits, counted as macOS's DiffEngine
//! counts them: an LCS diff of an Edit's old and new text, every line of a
//! Write, with the same size guards and the same set-based fallback for large
//! edits. It is done here because the relay sees the whole edit; the island
//! only gets each string's first 2,000 characters.

use serde_json::{json, Map, Value};

/// DiffEngine's guards: beyond these an edit is counted, not diffed.
const MAX_BYTES: usize = 200 * 1024;
const MAX_LINES: usize = 4000;
const MAX_CELLS: usize = 1_000_000;

#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub struct Counts {
    pub added: usize,
    pub removed: usize,
}

/// Lines of `text`, CRLF or LF, without the empty one after a final newline.
fn split_lines(text: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    parts
}

/// Length of the longest common subsequence of lines, in two rows of memory.
fn lcs_len(a: &[&str], b: &[&str]) -> usize {
    let mut prev = vec![0usize; b.len() + 1];
    let mut row = vec![0usize; b.len() + 1];
    for x in a {
        for (j, y) in b.iter().enumerate() {
            row[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(row[j]) };
        }
        std::mem::swap(&mut prev, &mut row);
    }
    prev[b.len()]
}

/// Too large to diff: lines present on one side only (DiffEngine.countFallback).
fn fallback(old: &str, new: &str) -> Counts {
    let a: Vec<&str> = old.split('\n').collect();
    let b: Vec<&str> = new.split('\n').collect();
    let (sa, sb): (std::collections::HashSet<&str>, std::collections::HashSet<&str>) =
        (a.iter().copied().collect(), b.iter().copied().collect());
    Counts {
        added: b.iter().filter(|l| !l.is_empty() && !sa.contains(*l)).count(),
        removed: a.iter().filter(|l| !l.is_empty() && !sb.contains(*l)).count(),
    }
}

/// An Edit: lines removed from `old` and added in `new`.
pub fn edit(old: &str, new: &str) -> Counts {
    if old.len() + new.len() > MAX_BYTES {
        return fallback(old, new);
    }
    let (a, b) = (split_lines(old), split_lines(new));
    if a.len() + b.len() > MAX_LINES || a.len() * b.len() > MAX_CELLS {
        return fallback(old, new);
    }
    let common = lcs_len(&a, &b);
    Counts { added: b.len() - common, removed: a.len() - common }
}

/// A Write: every line is new.
pub fn write(content: &str) -> Counts {
    let added = if content.len() > MAX_BYTES { content.split('\n').count() } else { split_lines(content).len() };
    Counts { added, removed: 0 }
}

/// `{ path, added, removed }` for Claude Code's Edit, MultiEdit and Write, or
/// None when the tool changed no lines or is not one of those.
pub fn of_tool(tool: &str, input: &Map<String, Value>) -> Option<Value> {
    fn text(v: Option<&Value>) -> Option<&str> {
        v.and_then(Value::as_str)
    }
    let path = text(input.get("file_path"))?;
    let counts = match tool {
        "Edit" => edit(text(input.get("old_string"))?, text(input.get("new_string"))?),
        "MultiEdit" => input.get("edits")?.as_array()?.iter().fold(Counts::default(), |sum, e| {
            match (text(e.get("old_string")), text(e.get("new_string"))) {
                (Some(old), Some(new)) => {
                    let c = edit(old, new);
                    Counts { added: sum.added + c.added, removed: sum.removed + c.removed }
                }
                _ => sum,
            }
        }),
        "Write" => write(text(input.get("content"))?),
        _ => return None,
    };
    (counts.added + counts.removed > 0)
        .then(|| json!({ "path": path, "added": counts.added, "removed": counts.removed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_counts_lines_like_the_lcs_diff() {
        assert_eq!(edit("a\nb\nc\n", "a\nB\nc\nd\n"), Counts { added: 2, removed: 1 });
        assert_eq!(edit("same", "same"), Counts::default());
        assert_eq!(edit("", "one\ntwo"), Counts { added: 2, removed: 0 });
        // CRLF and LF are the same lines.
        assert_eq!(edit("x\r\ny\r\n", "x\ny\n"), Counts::default());
        // Moving a line is one removal and one addition.
        assert_eq!(edit("1\n2\n3", "2\n3\n1"), Counts { added: 1, removed: 1 });
    }

    #[test]
    fn large_edits_fall_back_to_counting_unmatched_lines() {
        let old: String = (0..3000).map(|i| format!("line {i}\n")).collect();
        let new = format!("{old}extra one\nextra two\n");
        assert_eq!(edit(&old, &new), Counts { added: 2, removed: 0 });
    }

    #[test]
    fn a_write_counts_every_line() {
        assert_eq!(write("a\nb\nc\n"), Counts { added: 3, removed: 0 });
        assert_eq!(write("a\r\nb"), Counts { added: 2, removed: 0 });
    }

    #[test]
    fn only_editing_tools_with_changes_are_counted() {
        let input = |v: Value| v.as_object().unwrap().clone();
        assert_eq!(
            of_tool("Edit", &input(json!({ "file_path": "C:/p/a.rs", "old_string": "x", "new_string": "y\nz" }))),
            Some(json!({ "path": "C:/p/a.rs", "added": 2, "removed": 1 }))
        );
        assert_eq!(
            of_tool("MultiEdit", &input(json!({ "file_path": "f", "edits": [
                { "old_string": "a", "new_string": "b" }, { "old_string": "c", "new_string": "c\nd" }, { "bad": 1 }
            ] }))),
            Some(json!({ "path": "f", "added": 2, "removed": 1 }))
        );
        assert_eq!(of_tool("Write", &input(json!({ "file_path": "n.md", "content": "# Hi\n" })))
            .unwrap()["added"], 1);
        assert_eq!(of_tool("Edit", &input(json!({ "file_path": "f", "old_string": "s", "new_string": "s" }))), None);
        assert_eq!(of_tool("Bash", &input(json!({ "file_path": "f", "command": "ls" }))), None);
        assert_eq!(of_tool("Write", &input(json!({ "content": "no path" }))), None);
    }
}
