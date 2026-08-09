use serde::Serialize;
use serde_json::Value;

/// Compact, typed events — the only shapes that ever cross IPC.
/// Noise lines (`attachment`, `file-history-*`, tool results…) die here.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionEvent {
    #[serde(rename_all = "camelCase")]
    Text {
        session_id: String,
        uuid: String,
        msg_id: String,
        text: String,
        stop_reason: Option<String>,
        ts: String,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        session_id: String,
        uuid: String,
        msg_id: String,
        tool_name: String,
        input: ToolInput,
        ts: String,
    },
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        session_id: String,
        msg_id: String,
        ts: String,
    },
    #[serde(rename_all = "camelCase")]
    ApiError {
        session_id: String,
        message: String,
        retry_in_ms: Option<f64>,
        retry_attempt: Option<f64>,
        ts: String,
    },
    #[serde(rename_all = "camelCase")]
    Title { session_id: String, title: String },
}

impl SessionEvent {
    pub fn uuid(&self) -> Option<&str> {
        match self {
            SessionEvent::Text { uuid, .. } | SessionEvent::Tool { uuid, .. } => Some(uuid),
            _ => None,
        }
    }
}

/// Whitelisted subset of tool_use input — full inputs can be huge (file contents).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
}

fn s(v: &Value) -> Option<String> {
    v.as_str().map(|x| x.to_string())
}

/// Classify one complete JSONL line. `session_id` comes from the filename stem
/// (authoritative per recon — every line carries it, but the filename is free).
pub fn classify(line: &str, session_id: &str) -> Option<SessionEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let ts = s(&v["timestamp"]).unwrap_or_default();

    match v["type"].as_str()? {
        "assistant" => {
            if v["isSidechain"].as_bool() == Some(true) {
                return None;
            }
            if v["isApiErrorMessage"].as_bool() == Some(true) {
                return None;
            }
            let msg = &v["message"];
            if msg["model"].as_str() == Some("<synthetic>") {
                return None;
            }
            let uuid = s(&v["uuid"])?;
            let msg_id = s(&msg["id"]).unwrap_or_default();
            let stop_reason = s(&msg["stop_reason"]);
            // Each line carries exactly one content block (verified against v2.1.226).
            let block = msg["content"].as_array()?.first()?;
            match block["type"].as_str()? {
                "text" => {
                    let text = s(&block["text"])?;
                    if text.trim().is_empty() {
                        return None;
                    }
                    Some(SessionEvent::Text {
                        session_id: session_id.into(),
                        uuid,
                        msg_id,
                        text,
                        stop_reason,
                        ts,
                    })
                }
                "tool_use" => {
                    let input = &block["input"];
                    Some(SessionEvent::Tool {
                        session_id: session_id.into(),
                        uuid,
                        msg_id,
                        tool_name: s(&block["name"])?,
                        input: ToolInput {
                            file_path: s(&input["file_path"]).or_else(|| s(&input["notebook_path"])),
                            command: s(&input["command"]),
                            description: s(&input["description"]),
                            pattern: s(&input["pattern"]),
                            url: s(&input["url"]),
                            skill: s(&input["skill"]),
                        },
                        ts,
                    })
                }
                // thinking (or future block kinds) closing a turn still signals the chime.
                _ => {
                    if stop_reason.as_deref() == Some("end_turn") {
                        Some(SessionEvent::TurnEnd {
                            session_id: session_id.into(),
                            msg_id,
                            ts,
                        })
                    } else {
                        None
                    }
                }
            }
        }
        "system" => {
            if v["subtype"].as_str()? != "api_error" {
                return None;
            }
            let err = &v["error"];
            let message = s(&err["formatted"])
                .or_else(|| s(&err["message"]))
                .unwrap_or_else(|| "unknown API error".into());
            Some(SessionEvent::ApiError {
                session_id: session_id.into(),
                message,
                retry_in_ms: v["retryInMs"].as_f64().or_else(|| err["retryInMs"].as_f64()),
                retry_attempt: v["retryAttempt"].as_f64().or_else(|| err["retryAttempt"].as_f64()),
                ts,
            })
        }
        "ai-title" => Some(SessionEvent::Title {
            session_id: session_id.into(),
            title: s(&v["aiTitle"])?,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_line_classifies() {
        let line = r#"{"type":"assistant","uuid":"u1","isSidechain":false,"timestamp":"2026-08-08T16:03:54.449Z","message":{"id":"msg_1","model":"claude-fable-5","stop_reason":"tool_use","content":[{"type":"text","text":"Hello there."}]}}"#;
        match classify(line, "sess").unwrap() {
            SessionEvent::Text { text, stop_reason, msg_id, .. } => {
                assert_eq!(text, "Hello there.");
                assert_eq!(stop_reason.as_deref(), Some("tool_use"));
                assert_eq!(msg_id, "msg_1");
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn synthetic_and_sidechain_dropped() {
        let synth = r#"{"type":"assistant","uuid":"u2","message":{"model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}"#;
        assert!(classify(synth, "s").is_none());
        let side = r#"{"type":"assistant","uuid":"u3","isSidechain":true,"message":{"model":"claude-fable-5","content":[{"type":"text","text":"agent chatter"}]}}"#;
        assert!(classify(side, "s").is_none());
    }

    #[test]
    fn thinking_end_turn_becomes_turn_end() {
        let line = r#"{"type":"assistant","uuid":"u4","timestamp":"t","message":{"id":"msg_9","model":"claude-fable-5","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"","signature":"x"}]}}"#;
        match classify(line, "s").unwrap() {
            SessionEvent::TurnEnd { msg_id, .. } => assert_eq!(msg_id, "msg_9"),
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn tool_use_whitelists_input() {
        let line = r#"{"type":"assistant","uuid":"u5","timestamp":"t","message":{"id":"m","model":"claude-fable-5","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"D:\\x\\PillTabs.tsx","old_string":"HUGE","new_string":"HUGE"}}]}}"#;
        match classify(line, "s").unwrap() {
            SessionEvent::Tool { tool_name, input, .. } => {
                assert_eq!(tool_name, "Edit");
                assert_eq!(input.file_path.as_deref(), Some("D:\\x\\PillTabs.tsx"));
                assert!(input.command.is_none());
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn api_error_prefers_formatted() {
        let line = r#"{"type":"system","subtype":"api_error","timestamp":"t","retryInMs":3000,"retryAttempt":2,"error":{"message":"raw","formatted":"Unable to connect to API (ECONNRESET)"}}"#;
        match classify(line, "s").unwrap() {
            SessionEvent::ApiError { message, retry_in_ms, .. } => {
                assert_eq!(message, "Unable to connect to API (ECONNRESET)");
                assert_eq!(retry_in_ms, Some(3000.0));
            }
            other => panic!("wrong kind: {other:?}"),
        }
    }

    #[test]
    fn noise_types_dropped() {
        for line in [
            r#"{"type":"attachment","attachment":{"type":"output_style"}}"#,
            r#"{"type":"mode","mode":"plan"}"#,
            r#"{"type":"queue-operation","operation":"enqueue"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#,
            r#"{"type":"system","subtype":"stop_hook_summary"}"#,
            r#"not json at all"#,
        ] {
            assert!(classify(line, "s").is_none(), "should drop: {line}");
        }
    }

    #[test]
    fn ai_title_classifies() {
        let line = r#"{"type":"ai-title","sessionId":"x","aiTitle":"Build the thing"}"#;
        match classify(line, "s").unwrap() {
            SessionEvent::Title { title, .. } => assert_eq!(title, "Build the thing"),
            other => panic!("wrong kind: {other:?}"),
        }
    }
}
