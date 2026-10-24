//! Delta updates on Windows: when the latest release carries a patch from exactly the open-dock-pc.exe running
//! here (latest.json → delta.windows, made by scripts/make-delta.py), only the patch is downloaded and the new
//! exe is rebuilt next to this one. It must carry the release's updater signature (the same key and check as
//! the updater plugin) before it replaces this exe. Anything else returns None and the UI falls back to the
//! updater plugin's full installer.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf, time::Duration};

#[derive(Deserialize)]
struct Latest {
    version: String,
    #[serde(default)]
    notes: String,
    delta: Option<Deltas>,
}

#[derive(Deserialize)]
struct Deltas {
    windows: Option<Patch>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Patch {
    from: String,
    from_sha256: String,
    url: String,
    signature: String,
}

#[derive(Serialize)]
pub struct Ready {
    version: String,
    notes: String,
    bytes: usize,
}

fn updater_setting(app: &tauri::AppHandle, key: &str) -> Option<serde_json::Value> {
    app.config().plugins.0.get("updater")?.get(key).cloned()
}

fn new_exe() -> Result<PathBuf, String> {
    Ok(std::env::current_exe().map_err(|error| error.to_string())?.with_extension("new"))
}

/// Downloads and applies the patch, leaving the verified new exe as open-dock-pc.new.
#[tauri::command]
pub async fn download_delta_update(app: tauri::AppHandle) -> Result<Option<Ready>, String> {
    let Some(endpoint) = updater_setting(&app, "endpoints").and_then(|list| list.get(0)?.as_str().map(str::to_owned)) else {
        return Ok(None);
    };
    let current = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent("Open Dock")
        .build()
        .map_err(|error| error.to_string())?;
    let fetch = |url: String| {
        let client = client.clone();
        async move {
            let response = client.get(url).send().await.map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("GitHub answered {}", response.status()));
            }
            response.bytes().await.map_err(|error| error.to_string())
        }
    };
    let latest: Latest = serde_json::from_slice(&fetch(endpoint).await?).map_err(|error| error.to_string())?;
    let Some(patch) = latest.delta.and_then(|delta| delta.windows) else { return Ok(None) };
    if latest.version == current || patch.from != current {
        return Ok(None);
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let old = std::fs::read(&exe).map_err(|error| error.to_string())?;
    if hex(&Sha256::digest(&old)) != patch.from_sha256 {
        return Ok(None);
    }
    let body = fetch(patch.url).await?;
    let new = apply(&old, &body)?;
    let pubkey = updater_setting(&app, "pubkey").and_then(|key| key.as_str().map(str::to_owned)).unwrap_or_default();
    verify(&new, &pubkey, &patch.signature)?;
    std::fs::write(new_exe()?, &new).map_err(|error| format!("Could not save the update: {error}"))?;
    Ok(Some(Ready { version: latest.version, notes: latest.notes, bytes: body.len() }))
}

/// Swaps the new exe in (Windows lets a running exe be renamed, not overwritten) and starts it.
#[tauri::command]
pub fn install_delta_update(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let old = exe.with_extension("old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|error| format!("Could not replace Open Dock: {error}"))?;
    if let Err(error) = std::fs::rename(new_exe()?, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("Could not replace Open Dock: {error}"));
    }
    // ponytail: the uninstall entry keeps showing the installed version until the next full install.
    tauri_plugin_single_instance::destroy(&app);
    std::process::Command::new(&exe).spawn().map_err(|error| error.to_string())?;
    app.exit(0);
    Ok(())
}

/// The exe a delta update replaced; it can only go once the new one runs.
pub fn remove_replaced_exe() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(exe.with_extension("old"));
        let _ = std::fs::remove_file(exe.with_extension("new"));
    }
}

// The updater plugin's check: both the key and the signature are base64 of minisign's text files.
fn verify(data: &[u8], pubkey: &str, signature: &str) -> Result<(), String> {
    use base64::Engine;
    let text = |value: &str| {
        let bytes = base64::engine::general_purpose::STANDARD.decode(value).map_err(|error| error.to_string())?;
        String::from_utf8(bytes).map_err(|error| error.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&text(pubkey)?).map_err(|error| error.to_string())?;
    let signature = minisign_verify::Signature::decode(&text(signature)?).map_err(|error| error.to_string())?;
    key.verify(data, &signature, true).map_err(|_| "The update's signature doesn't match.".to_owned())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// bsdiff's 8-byte sign-magnitude integer.
fn offtin(bytes: &[u8]) -> i64 {
    let mut raw = [0; 8];
    raw.copy_from_slice(&bytes[..8]);
    let negative = raw[7] & 0x80 != 0;
    raw[7] &= 0x7F;
    let value = i64::from_le_bytes(raw);
    if negative { -value } else { value }
}

/// scripts/make-delta.py's format: "ODPATCH1", u64 new size, control and diff lengths, then three zlib blocks.
fn apply(old: &[u8], patch: &[u8]) -> Result<Vec<u8>, String> {
    let bad = || "The update patch is damaged.".to_owned();
    if patch.len() < 32 || &patch[..8] != b"ODPATCH1" {
        return Err(bad());
    }
    let number = |at: usize| u64::from_le_bytes(patch[at..at + 8].try_into().unwrap()) as usize;
    let (new_size, ctrl_len, diff_len) = (number(8), number(16), number(24));
    let body = &patch[32..];
    if ctrl_len.saturating_add(diff_len) > body.len() {
        return Err(bad());
    }
    let inflate = |block: &[u8]| {
        let mut out = Vec::new();
        flate2::read::ZlibDecoder::new(block).read_to_end(&mut out).map(|_| out).map_err(|_| bad())
    };
    let ctrl = inflate(&body[..ctrl_len])?;
    let diff = inflate(&body[ctrl_len..ctrl_len + diff_len])?;
    let extra = inflate(&body[ctrl_len + diff_len..])?;
    let mut out = Vec::with_capacity(new_size);
    let (mut old_pos, mut diff_pos, mut extra_pos) = (0_i64, 0_usize, 0_usize);
    for triple in ctrl.chunks_exact(24) {
        let (x, y, z) = (offtin(&triple[..8]), offtin(&triple[8..16]), offtin(&triple[16..]));
        let (x, y) = (usize::try_from(x).map_err(|_| bad())?, usize::try_from(y).map_err(|_| bad())?);
        let added = diff.get(diff_pos..diff_pos + x).ok_or_else(bad)?;
        for (i, byte) in added.iter().enumerate() {
            // Old bytes outside the file count as zero, as in bsdiff.
            let source = usize::try_from(old_pos + i as i64).ok().and_then(|at| old.get(at)).copied().unwrap_or(0);
            out.push(byte.wrapping_add(source));
        }
        diff_pos += x;
        old_pos += x as i64;
        out.extend_from_slice(extra.get(extra_pos..extra_pos + y).ok_or_else(bad)?);
        extra_pos += y;
        old_pos += z;
        if out.len() > new_size {
            return Err(bad());
        }
    }
    if out.len() != new_size {
        return Err(bad());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    // A patch from scripts/make-delta.py: python scripts/make-delta.py diff old new patch.
    #[test]
    fn applies_make_delta_patches() {
        let dir = std::env::temp_dir().join("open-dock-delta-test");
        std::fs::create_dir_all(&dir).unwrap();
        let old: Vec<u8> = (0..50_000_u32).map(|i| (i * 7919 % 251) as u8).collect();
        let mut new = old.clone();
        new[100..110].copy_from_slice(b"0123456789");
        new.splice(20_000..20_000, b"inserted".repeat(50));
        new.truncate(45_000);
        new.extend_from_slice(b"tail");
        std::fs::write(dir.join("old"), &old).unwrap();
        std::fs::write(dir.join("new"), &new).unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/make-delta.py");
        let status = std::process::Command::new("python")
            .arg(script).arg("diff").arg(dir.join("old")).arg(dir.join("new")).arg(dir.join("patch"))
            .status();
        let Ok(status) = status else { return }; // no Python here: nothing to compare against
        assert!(status.success());
        let patch = std::fs::read(dir.join("patch")).unwrap();
        assert_eq!(super::apply(&old, &patch).unwrap(), new);
        assert!(super::apply(&old, &patch[..patch.len() - 3]).is_err());
    }
}
