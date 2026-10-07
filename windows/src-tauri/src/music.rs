// Now playing, for the Music pill: Windows' own media session, the one behind
// the volume flyout's controls, so it follows Spotify, Apple Music, a browser
// tab or any player that shows up there. macOS reads Apple Music instead
// (MusicController.swift). Only the title, artist, album and whether it plays
// are read, only while the Music pill is on, and nothing leaves the computer.
// Linux has no reader yet: the pill stays on "Not playing".

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
}

/// The last reading sent to the island, so only changes go out.
static LAST: Mutex<Option<NowPlaying>> = Mutex::new(None);

const EVERY: Duration = Duration::from_millis(1500);

/// "Song (Remastered 2011) - Live" → "Song": as MusicController.shortTitle.
pub fn short_title(raw: &str) -> String {
    let mut s = raw.split(" - ").next().unwrap_or(raw).trim().to_string();
    loop {
        let close = match s.chars().last() {
            Some(c @ (')' | ']')) => c,
            _ => break,
        };
        let open = if close == ')' { '(' } else { '[' };
        let Some(i) = s.rfind(open) else { break };
        let candidate = s[..i].trim().to_string();
        if candidate.is_empty() {
            break;
        }
        s = candidate;
    }
    if s.is_empty() { raw.trim().to_string() } else { s }
}

/// "Artist feat. Someone" → "Artist": as MusicController.shortArtist.
pub fn short_artist(raw: &str) -> String {
    for tag in [" feat.", " ft."] {
        // Case-insensitive, on the original text: lowercasing can move byte offsets.
        let at = raw.char_indices().map(|(i, _)| i).find(|&i| {
            raw.get(i..i + tag.len()).is_some_and(|s| s.eq_ignore_ascii_case(tag))
        });
        if let Some(i) = at {
            let cut = raw[..i].trim();
            if !cut.is_empty() {
                return cut.to_string();
            }
        }
    }
    raw.to_string()
}

/// A reading, tidied; None when nothing has a title.
fn tidy(title: &str, artist: &str, album: &str, playing: bool) -> Option<NowPlaying> {
    let title = short_title(title);
    if title.trim().is_empty() {
        return None;
    }
    Some(NowPlaying {
        title,
        artist: short_artist(artist.trim()),
        album: album.trim().to_string(),
        playing,
    })
}

fn pill_on(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().active_integrations.iter().any(|id| id == "integration_music"))
        .unwrap_or(false)
}

/// Sends a reading to the island if it differs from the last one.
fn publish(app: &AppHandle, now: Option<NowPlaying>) {
    let mut last = LAST.lock().unwrap();
    if *last == now {
        return;
    }
    *last = now.clone();
    let _ = app.emit("music", now);
}

pub fn latest() -> Option<NowPlaying> {
    LAST.lock().unwrap().clone()
}

pub fn start(app: AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        let mut reader: Option<win::Reader> = None;
        loop {
            if pill_on(&app) {
                if reader.is_none() {
                    reader = win::Reader::new();
                }
                let now = reader.as_ref().and_then(win::Reader::read);
                publish(&app, now);
            } else {
                publish(&app, None);
            }
            std::thread::sleep(EVERY);
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

/// Play/pause, next or previous on the current session, then a fresh reading.
pub fn control(app: &AppHandle, action: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let reader = win::Reader::new().ok_or("Windows media controls are not available.")?;
        reader.control(action)?;
        // The player takes a moment to report its new state.
        std::thread::sleep(Duration::from_millis(250));
        if pill_on(app) {
            publish(app, reader.read());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, action);
        Err("Music controls are not available on this system yet.".into())
    }
}

#[cfg(windows)]
mod win {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    use super::{tidy, NowPlaying};

    pub struct Reader {
        manager: SessionManager,
    }

    impl Reader {
        pub fn new() -> Option<Self> {
            let manager = SessionManager::RequestAsync().ok()?.get().ok()?;
            Some(Self { manager })
        }

        /// The session Windows itself shows first (the flyout's).
        pub fn read(&self) -> Option<NowPlaying> {
            let session = self.manager.GetCurrentSession().ok()?;
            let playing = session.GetPlaybackInfo().ok()?.PlaybackStatus().ok()? == Status::Playing;
            let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
            let text = |r: windows::core::Result<windows::core::HSTRING>| r.map(|h| h.to_string_lossy()).unwrap_or_default();
            tidy(&text(props.Title()), &text(props.Artist()), &text(props.AlbumTitle()), playing)
        }

        /// Each step of read(), for the native test.
        #[cfg(test)]
        pub fn diagnose(&self) -> String {
            let session = match self.manager.GetCurrentSession() {
                Ok(s) => s,
                Err(e) => return format!("no current session: {e:?}"),
            };
            let status = session.GetPlaybackInfo().and_then(|i| i.PlaybackStatus());
            let props = session.TryGetMediaPropertiesAsync().and_then(|op| op.get());
            let title = props.as_ref().map(|p| p.Title().map(|h| h.to_string_lossy()));
            format!("app {:?}, status {:?}, title {:?}", session.SourceAppUserModelId().map(|h| h.to_string_lossy()), status, title)
        }

        pub fn control(&self, action: &str) -> Result<(), String> {
            let session = self.manager.GetCurrentSession().map_err(|_| "Nothing is playing.".to_string())?;
            let done = match action {
                "toggle" => session.TryTogglePlayPauseAsync(),
                "next" => session.TrySkipNextAsync(),
                "previous" => session.TrySkipPreviousAsync(),
                _ => return Err(format!("Unknown music action: {action}")),
            };
            match done.and_then(|op| op.get()) {
                Ok(true) => Ok(()),
                _ => Err("The player did not accept that.".into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_artists_are_shortened_like_the_mac() {
        assert_eq!(short_title("Hey Jude - Remastered 2015"), "Hey Jude");
        assert_eq!(short_title("Song (Live) [Deluxe]"), "Song");
        assert_eq!(short_title("(Intro)"), "(Intro)", "never shortened to nothing");
        assert_eq!(short_title("Plain"), "Plain");
        assert_eq!(short_artist("Daft Punk feat. Pharrell Williams"), "Daft Punk");
        assert_eq!(short_artist("Someone Ft. Other"), "Someone");
        assert_eq!(short_artist("Solo"), "Solo");
        assert_eq!(short_artist("İstanbul Ft. Ünal"), "İstanbul", "non-ASCII names are safe");
    }

    #[test]
    fn a_reading_needs_a_title() {
        assert_eq!(tidy("  ", "Artist", "Album", true), None);
        let r = tidy("Song (Radio Edit)", "A ft. B", " Album ", false).unwrap();
        assert_eq!((r.title.as_str(), r.artist.as_str(), r.album.as_str(), r.playing), ("Song", "A", "Album", false));
    }

    /// Reads the real session on this machine (`-- --ignored`).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_the_windows_media_session() {
        let reader = win::Reader::new().expect("media session manager");
        println!("steps: {}", reader.diagnose());
        println!("now playing: {:?}", reader.read());
    }
}
