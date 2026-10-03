// API keys live in the Windows Credential Manager or, on Linux, the Secret
// Service (GNOME Keyring, KWallet) — never on disk and never in the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

/// Every key Coucou may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "openai-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Result<Entry, String> {
    if !KNOWN_KEYS.contains(&key) {
        return Err("Unknown credential name.".into());
    }
    Entry::new(SERVICE, key).map_err(|_| "Could not open the credential store.".into())
}

pub fn get(key: &str) -> Option<String> {
    read(key).ok().flatten()
}

/// Distinguish an absent key from a locked or unavailable credential store.
pub fn read(key: &str) -> Result<Option<String>, String> {
    read_entry(&entry(key)?)
}

fn read_entry(entry: &Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok((!value.is_empty()).then_some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the credential store. Unlock it and try again.".into()),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    write_entry(&entry(key)?, value)
}

fn write_entry(entry: &Entry, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return clear_entry(entry);
    }
    entry.set_password(value).map_err(|_| "Could not save to the credential store.")?;
    if read_entry(entry)?.as_deref() != Some(value) {
        return Err("The saved key could not be verified. Try saving it again.".into());
    }
    Ok(())
}

pub fn clear(key: &str) -> Result<(), String> {
    clear_entry(&entry(key)?)
}

fn clear_entry(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("Could not remove the key from the credential store.".into()),
    }
    if read_entry(entry)?.is_some() {
        return Err("The key is still present. Try removing it again.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_credential_names() {
        assert!(read("not-a-coucou-key").is_err());
        assert!(set("not-a-coucou-key", "test").is_err());
        assert!(clear("not-a-coucou-key").is_err());
    }

    #[test]
    #[ignore = "Uses an isolated native credential entry, never the user's API key"]
    fn native_credential_round_trip() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let entry = Entry::new(&format!("fr.louisraille.coucou.test.{unique}"), "test-key").unwrap();
        struct Cleanup(Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) { let _ = self.0.delete_credential(); }
        }
        let cleanup = Cleanup(entry);
        let entry = &cleanup.0;
        assert!(read_entry(entry).unwrap().is_none());
        write_entry(entry, "non-secret-test-value").unwrap();
        assert!(read_entry(entry).unwrap().as_deref() == Some("non-secret-test-value"));
        write_entry(entry, "replacement-test-value").unwrap();
        assert!(read_entry(entry).unwrap().as_deref() == Some("replacement-test-value"));
        clear_entry(entry).unwrap();
        assert!(read_entry(entry).unwrap().is_none());
        clear_entry(entry).unwrap();
        write_entry(entry, "").unwrap();
    }
}
