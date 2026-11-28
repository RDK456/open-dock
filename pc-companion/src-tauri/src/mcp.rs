//! Lets an AI assistant press deck keys: a small Model Context Protocol server (streamable HTTP, JSON replies only)
//! at POST /mcp on the connection server. Only this PC may call it (loopback), with the pairing key as a bearer token:
//! `claude mcp add --transport http opendock http://127.0.0.1:39421/mcp --header "Authorization: Bearer <key>"`.
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

/// The command that adds this PC's Open Dock to Claude Code, pairing key included.
#[tauri::command]
pub fn mcp_command(state: tauri::State<'_, Arc<AppState>>) -> String {
    let token = state.token.read().map(|token| token.clone()).unwrap_or_default();
    format!("claude mcp add --transport http opendock http://127.0.0.1:{}/mcp --header \"Authorization: Bearer {token}\"", super::PORT)
}

use super::{read_deck, run_deck_action, AppState, DeckButton, DeckConfig};

pub async fn handle(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let token = state.token.read().map(|token| token.clone()).unwrap_or_default();
    let bearer = headers.get("authorization").and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer "));
    if !peer.ip().is_loopback() || token.is_empty() || bearer != Some(token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(request) = serde_json::from_str::<Value>(&body) else {
        return axum::Json(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })).into_response();
    };
    // Notifications (no id) get no reply.
    let Some(id) = request.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let reply = match request.get("method").and_then(Value::as_str).unwrap_or_default() {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "open-dock", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Open Dock is a deck of keys on the user's phone that control this PC. List the keys, then press one by its id."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [
            { "name": "list_keys", "description": "Every key on the Open Dock decks: its id, label, deck, profile and page.",
              "inputSchema": { "type": "object", "properties": {} } },
            { "name": "press_key", "description": "Presses one Open Dock key, as if tapped on the phone.",
              "inputSchema": { "type": "object", "properties": {
                  "key_id": { "type": "string", "description": "The key's id from list_keys." },
                  "deck": { "type": "string", "description": "The deck from list_keys; leave out for the shared deck." } },
                "required": ["key_id"] } }
        ] })),
        "tools/call" => Ok(call(&state, &params)),
        _ => Err(json!({ "code": -32601, "message": "Method not found" })),
    };
    axum::Json(match reply {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
    .into_response()
}

fn call(state: &AppState, params: &Value) -> Value {
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let outcome = match params.get("name").and_then(Value::as_str).unwrap_or_default() {
        "list_keys" => Ok(list_keys(state).to_string()),
        "press_key" => press_key(state, args.get("deck").and_then(Value::as_str).unwrap_or_default(), args.get("key_id").and_then(Value::as_str).unwrap_or_default()),
        other => Err(format!("Unknown tool {other}")),
    };
    match outcome {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
        Err(error) => json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
    }
}

/// The shared deck ("") and every phone with a deck of its own.
fn decks(state: &AppState) -> Vec<String> {
    let mut keys = vec![String::new()];
    if let Ok(decks) = state.device_decks.read() {
        keys.extend(decks.keys().cloned());
    }
    keys
}

fn buttons(config: &DeckConfig) -> impl Iterator<Item = (&str, &str, &DeckButton)> {
    config.profiles.iter().flat_map(|profile| {
        profile.pages.iter().flat_map(move |page| {
            page.buttons.iter().chain(page.folders.iter().flat_map(|folder| &folder.buttons))
                .map(move |button| (profile.name.as_str(), page.name.as_str(), button))
        })
    })
}

fn list_keys(state: &AppState) -> Value {
    let mut keys = Vec::new();
    for deck in decks(state) {
        let Some(config) = read_deck(state, &deck) else { continue };
        for (profile, page, button) in buttons(&config) {
            keys.push(json!({ "id": button.id, "label": button.label, "deck": deck, "profile": profile, "page": page }));
        }
    }
    Value::Array(keys)
}

fn press_key(state: &AppState, deck: &str, key_id: &str) -> Result<String, String> {
    let config = read_deck(state, deck).ok_or("That deck doesn't exist")?;
    let (_, _, button) = buttons(&config).find(|(_, _, button)| button.id == key_id).ok_or("No key has that id; call list_keys")?;
    let (mut profile, mut page) = (config.active_profile_id.clone(), String::new());
    run_deck_action(&button.action, state, deck, config.revision, true, &mut profile, &mut page)?;
    Ok(format!("Pressed {}", if button.label.is_empty() { key_id } else { &button.label }))
}
