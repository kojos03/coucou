//! Explicit project actions. Hook-provided paths are data, never shell code.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::platform;

fn working_directory(path: Option<&str>) -> Result<PathBuf, String> {
    let path = path.filter(|value| !value.is_empty())
        .ok_or("No working folder is available. Start a new coding turn first.")?;
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err("The working folder is unavailable. Check that it still exists and is accessible.".into());
    }
    Ok(path.to_path_buf())
}

pub fn vscode(path: Option<&str>) -> Result<(), String> {
    let cwd = path.filter(|value| !value.is_empty()).map(|value| working_directory(Some(value))).transpose()?;
    let code = platform::find_on_path("code")
        .ok_or("VS Code was not found. Install it with its command-line launcher on PATH, then restart Coucou.")?;
    platform::no_console(&mut vscode_command(&code, cwd.as_deref())).spawn()
        .map(|_| ())
        .map_err(|_| "Could not open VS Code. Check its installation and try again.".into())
}

fn vscode_command(code: &Path, cwd: Option<&Path>) -> Command {
    let mut cmd = Command::new(code);
    cmd.arg("--reuse-window");
    if let Some(cwd) = cwd { cmd.arg(cwd); }
    cmd
}

pub fn terminal(path: Option<&str>) -> Result<(), String> {
    let cwd = working_directory(path)?;
    #[cfg(windows)]
    {
        // Windows PowerShell is available even when PowerShell 7 is not installed.
        let shell = std::env::var_os("SystemRoot").map(PathBuf::from)
            .map(|root| root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .filter(|path| path.is_file())
            .ok_or("PowerShell was not found. Repair Windows PowerShell and try again.")?;
        if let Some(wt) = platform::find_on_path("wt") {
            if platform::no_console(&mut terminal_tab(&wt, &shell, &cwd)).spawn().is_ok() {
                return Ok(());
            }
        }
        powershell(&shell, &cwd).spawn().map(|_| ())
            .map_err(|_| "Could not open Windows Terminal or PowerShell. Check their installation and try again.".into())
    }
    #[cfg(not(windows))]
    {
        let _ = cwd;
        Err("Terminal launching is currently available on Windows. Use Open in VS Code on this platform.".into())
    }
}

/// Opens the official Claude Code in a terminal with the user's question, for a
/// full Claude Code session on their own Claude sign-in. The question travels
/// in a file in Coucou's folder, mentioned as `@file`, so nothing the user typed
/// reaches a command line.
pub fn claude_code(question: &str) -> Result<(), String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("Type a question first.".into());
    }
    let claude = find_claude().ok_or(
        "Claude Code was not found. Install it, sign in once by running `claude` in a terminal, then try again.",
    )?;
    let dir = crate::settings::local_dir().join("mochi").join("claude");
    std::fs::create_dir_all(&dir).map_err(|_| "Could not prepare the folder for Claude Code.".to_string())?;
    let name = handoff_file(&dir, question)?;
    #[cfg(windows)]
    {
        let prompt = format!("@{name}");
        if let Some(wt) = platform::find_on_path("wt") {
            if platform::no_console(&mut claude_tab(&wt, &claude, &dir, &prompt)).spawn().is_ok() {
                return Ok(());
            }
        }
        claude_console(&claude, &dir, &prompt).spawn().map(|_| ())
            .map_err(|_| "Could not open Claude Code. Check its installation and try again.".into())
    }
    #[cfg(not(windows))]
    {
        let _ = (claude, name);
        Err("Opening Claude Code from Mochi is currently available on Windows.".into())
    }
}

/// Saves the question and returns its file name: letters, digits, `-` and `.` only.
fn handoff_file(dir: &Path, question: &str) -> Result<String, String> {
    let name = format!("question-{}.md", crate::hooks::stamp());
    std::fs::write(dir.join(&name), format!("A question passed on from Coucou's Mochi:\n\n{question}\n"))
        .map_err(|_| "Could not save the question for Claude Code.".to_string())?;
    Ok(name)
}

pub(crate) fn find_claude() -> Option<PathBuf> {
    platform::find_on_path("claude").or_else(|| {
        // Where the native installer puts it, until a restart picks up the new PATH.
        let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
        let installed = platform::home_dir().join(".local").join("bin").join(exe);
        installed.is_file().then_some(installed)
    })
}

#[cfg(windows)]
fn claude_tab(wt: &Path, claude: &Path, dir: &Path, prompt: &str) -> Command {
    let mut cmd = Command::new(wt);
    cmd.current_dir(dir).args(["-w", "0", "new-tab", "--startingDirectory", "."]).arg(claude).arg(prompt);
    cmd
}

#[cfg(windows)]
fn claude_console(claude: &Path, dir: &Path, prompt: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(claude);
    // The user's explicit hand-off, so the console must be visible.
    cmd.creation_flags(0x0000_0010).current_dir(dir).arg(prompt);
    cmd
}

#[cfg(windows)]
fn terminal_tab(wt: &Path, shell: &Path, cwd: &Path) -> Command {
    let mut cmd = Command::new(wt);
    // A literal '.' plus the inherited cwd avoids wt's semicolon command parser
    // interpreting characters in the project path. No user path enters a script.
    cmd.current_dir(cwd).args(["-w", "0", "new-tab", "--startingDirectory", "."])
        .arg(shell).args(["-NoLogo", "-NoProfile", "-NoExit"]);
    cmd
}

#[cfg(windows)]
fn powershell(shell: &Path, cwd: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(shell);
    // This is the user's explicit terminal action, so the console must be visible.
    cmd.creation_flags(0x0000_0010).current_dir(cwd)
        .args(["-NoLogo", "-NoProfile", "-NoExit"]);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_relative_and_non_directory_paths() {
        assert!(working_directory(None).is_err());
        assert!(working_directory(Some("")).is_err());
        assert!(working_directory(Some("--help")).is_err());
        assert!(working_directory(Some(".")).is_err());
        let executable = std::env::current_exe().unwrap();
        assert!(working_directory(executable.to_str()).is_err());
        let absent = std::env::temp_dir().join("coucou-folder-that-does-not-exist");
        assert!(working_directory(absent.to_str()).is_err());
    }

    #[test]
    fn the_claude_hand_off_keeps_the_question_off_the_command_line() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("coucou-handoff-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        let question = "What's 2 & 2; \"quoted\" %TEMP% $env:X";
        let name = handoff_file(&dir, question).unwrap();
        assert!(name.starts_with("question-") && name.ends_with(".md"));
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
        assert!(std::fs::read_to_string(dir.join(&name)).unwrap().contains(question));
        #[cfg(windows)]
        {
            let prompt = format!("@{name}");
            let tab = claude_tab(Path::new("wt.exe"), Path::new("claude.exe"), &dir, &prompt);
            assert_eq!(tab.get_current_dir(), Some(dir.as_path()));
            let args: Vec<_> = tab.get_args().map(|a| a.to_string_lossy().to_string()).collect();
            assert_eq!(args.last(), Some(&prompt));
            assert!(!args.iter().any(|a| a.contains("2 & 2")));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn terminal_arguments_do_not_interpolate_the_project_path() {
        let cwd = Path::new(r"C:\project space\日本語 & $test; %TEMP% ' (1)");
        let cmd = terminal_tab(Path::new("wt.exe"), Path::new("powershell.exe"), cwd);
        assert_eq!(cmd.get_current_dir(), Some(cwd));
        assert!(!cmd.get_args().any(|arg| arg == cwd.as_os_str()));
        assert!(cmd.get_args().any(|arg| arg == "."));
        let code = vscode_command(Path::new("code.cmd"), Some(cwd));
        assert_eq!(code.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("--reuse-window"), cwd.as_os_str()]);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Starts a hidden native PowerShell process to verify its working folder"]
    fn native_powershell_preserves_literal_working_directory() {
        use std::os::windows::process::CommandExt;
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let cwd = std::env::temp_dir().join(format!("coucou-{unique} 日本語 & $test; %TEMP% ' (1)"));
        std::fs::create_dir(&cwd).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) { let _ = std::fs::remove_dir(&self.0); }
        }
        let _cleanup = Cleanup(cwd.clone());
        assert_eq!(working_directory(cwd.to_str()).unwrap(), cwd);
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = powershell(&shell, &cwd).creation_flags(0x0800_0000)
            .args(["-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write((Get-Location).ProviderPath); exit"])
            .output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim_start_matches('\u{feff}'), cwd.to_str().unwrap());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Opens a temporary Windows Terminal tab that exits after recording its working folder"]
    fn native_windows_terminal_preserves_literal_working_directory() {
        let wt = platform::find_on_path("wt").expect("Windows Terminal is required for this explicit test");
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let cwd = std::env::temp_dir().join(format!("coucou-wt-{unique} 日本語 & $test; %TEMP% ' (1)"));
        std::fs::create_dir(&cwd).unwrap();
        let output = cwd.join("working-directory.txt");
        struct Cleanup(PathBuf, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.1);
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _cleanup = Cleanup(cwd.clone(), output.clone());
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut cmd = terminal_tab(&wt, &shell, &cwd);
        cmd.env("COUCOU_TEST_OUTPUT", &output).args(["-Command",
            "try { [System.IO.File]::WriteAllText($env:COUCOU_TEST_OUTPUT, (Get-Location).ProviderPath) } finally { exit }"]);
        let mut child = platform::no_console(&mut cmd).spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !output.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let observed = std::fs::read_to_string(&output).expect("Terminal did not report a working directory");
        assert_eq!(observed.trim_start_matches('\u{feff}'), cwd.to_str().unwrap());
        let _ = child.try_wait();
    }
}
