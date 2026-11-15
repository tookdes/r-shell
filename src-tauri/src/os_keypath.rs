use std::path::Path;

pub const DEFAULT_KEY_FILES: [&str; 3] = ["id_rsa", "id_ecdsa", "id_ed25519"];

pub fn default_key_candidates() -> Vec<String> {
    dirs::home_dir()
        .map(|home| default_key_candidates_with_home(&home))
        .unwrap_or_default()
}

fn default_key_candidates_with_home(home: &Path) -> Vec<String> {
    DEFAULT_KEY_FILES
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Resolve an explicit private-key path, or fall back to the conventional
/// default keys. Keep id_rsa first to match upstream v2.9.2 behaviour.
pub fn resolve_private_key_path(key_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        if !path.starts_with("~/") && !path.starts_with("~\\") {
            return Ok(path.to_string());
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    resolve_private_key_path_with_home(key_path, &home)
}

fn resolve_private_key_path_with_home(
    key_path: Option<&str>,
    home: &Path,
) -> Result<String, String> {
    if let Some(path) = key_path.map(str::trim).filter(|path| !path.is_empty()) {
        return Ok(expand_tilde_with_home(path, home));
    }

    let candidates = default_key_candidates_with_home(home);
    if let Some(candidate) = candidates.first() {
        return Ok(candidate.clone());
    }

    Err(format!(
        "No default SSH private key found in {}. Checked {}.",
        home.join(".ssh").display(),
        DEFAULT_KEY_FILES.join(", "),
    ))
}

fn expand_tilde_with_home(key_path: &str, home: &Path) -> String {
    if key_path.starts_with("~/") || key_path.starts_with("~\\") {
        return key_path.replacen('~', &home.to_string_lossy(), 1);
    }
    key_path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn test_home(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("r-shell-keypath-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_key(home: &Path, filename: &str) -> PathBuf {
        let path = home.join(".ssh").join(filename);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "test key").unwrap();
        path
    }

    #[test]
    fn explicit_path_is_trimmed_and_tilde_expanded() {
        let home = test_home("explicit");
        assert_eq!(
            resolve_private_key_path_with_home(Some(" /abs/key "), &home).unwrap(),
            "/abs/key"
        );
        assert_eq!(
            resolve_private_key_path_with_home(Some("~/keys/k1"), &home).unwrap(),
            format!("{}/keys/k1", home.to_string_lossy())
        );
    }

    #[test]
    fn blank_input_prefers_rsa_then_ed25519() {
        let home = test_home("defaults");
        let rsa = write_key(&home, "id_rsa");
        write_key(&home, "id_ed25519");
        assert_eq!(
            resolve_private_key_path_with_home(None, &home).unwrap(),
            rsa.to_string_lossy()
        );

        let home2 = test_home("ed25519");
        let ed = write_key(&home2, "id_ed25519");
        assert_eq!(
            resolve_private_key_path_with_home(Some("  "), &home2).unwrap(),
            ed.to_string_lossy()
        );
    }

    #[test]
    fn default_candidates_follow_openssh_order() {
        let home = test_home("candidate-order");
        let ed25519 = write_key(&home, "id_ed25519");
        let rsa = write_key(&home, "id_rsa");
        let ecdsa = write_key(&home, "id_ecdsa");

        assert_eq!(
            default_key_candidates_with_home(&home),
            vec![
                rsa.to_string_lossy().into_owned(),
                ecdsa.to_string_lossy().into_owned(),
                ed25519.to_string_lossy().into_owned(),
            ]
        );
    }

    #[test]
    fn missing_defaults_reports_all_candidates() {
        let home = test_home("missing");
        let err = resolve_private_key_path_with_home(None, &home).unwrap_err();
        assert!(DEFAULT_KEY_FILES.iter().all(|name| err.contains(name)));
    }
}
