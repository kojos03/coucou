// The weekly recap's history file, %LOCALAPPDATA%\Coucou\recap.json, and its
// share image. The island keeps the history and makes the summary (core/recap.ts);
// Rust only reads, writes and clears the file, and saves the image. Nothing
// here leaves the computer.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{hooks, platform, settings};

pub fn path() -> PathBuf {
    settings::local_dir().join("recap.json")
}

/// The saved history, or None when there is none yet. A file that is not a
/// JSON object is set aside (`recap.corrupt-<time>`) rather than lost, and the
/// history starts again, as on macOS.
pub fn load() -> Option<String> {
    let (text, aside) = load_at(&path());
    if let Some(aside) = aside {
        crate::log::line(format!("recap: unreadable history set aside as {}", aside.display()));
    }
    text
}

/// The history, and where an unreadable one was moved.
fn load_at(path: &Path) -> (Option<String>, Option<PathBuf>) {
    let Ok(text) = std::fs::read_to_string(path) else { return (None, None) };
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if value.is_object() => (Some(text), None),
        _ => {
            let aside = path.with_file_name(format!("recap.corrupt-{}", hooks::stamp()));
            let _ = std::fs::rename(path, &aside);
            (None, Some(aside))
        }
    }
}

pub fn save(text: &str) -> Result<(), String> {
    save_at(&path(), text)
}

fn save_at(path: &Path, text: &str) -> Result<(), String> {
    if !serde_json::from_str::<Value>(text).is_ok_and(|v| v.is_object()) {
        return Err("not a recap history".into());
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("write failed: {e}"))?;
    // Beside the file, then renamed over it: a failed write keeps the old one.
    let temp = path.with_file_name(format!("recap.json.coucou-{}", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("write failed: {e}")
    })
}

pub fn clear() -> Result<(), String> {
    match std::fs::remove_file(path()) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Can't clear the history: {err}")),
    }
}

/// Pictures\Coucou, or Coucou's own folder when there is no Pictures folder.
fn images_dir() -> PathBuf {
    let pictures = platform::home_dir().join("Pictures");
    if pictures.is_dir() { pictures.join("Coucou") } else { settings::local_dir().join("recap") }
}

/// A file name of letters, digits, `-`, `_` and `.`, ending in .png.
fn safe_name(name: &str) -> String {
    let stem: String = name
        .trim_end_matches(".png")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    let stem = stem.trim_matches('.');
    format!("{}.png", if stem.is_empty() { "coucou-weekly-recap" } else { stem })
}

/// Saves the share image and opens it in the default viewer, where it can be
/// copied or shared. Returns where it went.
pub fn save_image(png: &[u8], name: &str) -> Result<String, String> {
    save_image_in(&images_dir(), png, name).inspect(|path| platform::open_url(path))
}

fn save_image_in(dir: &Path, png: &[u8], name: &str) -> Result<String, String> {
    const SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];
    if !png.starts_with(SIGNATURE) {
        return Err("not a PNG image".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("save failed: {e}"))?;
    let path = dir.join(safe_name(name));
    std::fs::write(&path, png).map_err(|e| format!("save failed: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-recap-{name}-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_history_round_trips_and_a_broken_file_is_set_aside() {
        let dir = temp_dir("history");
        let path = dir.join("recap.json");
        assert_eq!(load_at(&path), (None, None));
        save_at(&path, r#"{"turns":[],"decisions":[],"schemaVersion":1}"#).unwrap();
        assert!(load_at(&path).0.unwrap().contains("schemaVersion"));
        assert!(save_at(&path, "[1, 2]").is_err(), "only a history object is written");
        std::fs::write(&path, "{ broken").unwrap();
        let (text, aside) = load_at(&path);
        assert_eq!(text, None);
        assert!(aside.is_some_and(|a| a.exists()));
        assert!(!path.exists());
        let aside: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert!(aside.iter().any(|n| n.starts_with("recap.corrupt-")), "{aside:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn images_are_pngs_with_safe_names() {
        let dir = temp_dir("image");
        let png = [&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'][..], b"rest"].concat();
        let saved = save_image_in(&dir, &png, "coucou-weekly-recap-2026-09-28").unwrap();
        assert!(saved.ends_with("coucou-weekly-recap-2026-09-28.png"));
        assert_eq!(std::fs::read(&saved).unwrap(), png);
        assert!(save_image_in(&dir, b"GIF89a", "x").is_err());
        assert_eq!(safe_name("..\\..\\evil name.png"), "evilname.png");
        assert_eq!(safe_name(""), "coucou-weekly-recap.png");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
