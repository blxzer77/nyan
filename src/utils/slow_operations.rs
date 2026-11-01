//! Maps to: CC `utils/slowOperations.ts#jsonStringify:170–194` and `#jsonParse:204–211`.
//! Current consumer subset: no replacer/reviver, numeric indentation (0–10).
//! Feature-enabled slow-operation logging and other exports remain deferred.

use crate::utils::json::JsoncValue;
use serde_json::Value;
use std::borrow::Cow;

/// Necessary shared input adapter; retain JavaScript UTF-16 strings until
/// JSON.stringify instead of projecting them through lossy Rust String first.
pub trait JsonStringifyInput {
    fn json_value(&self) -> Cow<'_, JsoncValue>;
}
impl JsonStringifyInput for Value {
    fn json_value(&self) -> Cow<'_, JsoncValue> {
        Cow::Owned(JsoncValue::from_json(self.clone()))
    }
}
impl JsonStringifyInput for JsoncValue {
    fn json_value(&self) -> Cow<'_, JsoncValue> {
        Cow::Borrowed(self)
    }
}

/// Maps to: CC `utils/slowOperations.ts#jsonStringify:180–194`, replacer absent.
pub fn json_stringify(value: &(impl JsonStringifyInput + ?Sized), indent: usize) -> String {
    stringify_json_value(&value.json_value(), indent.min(10), 0)
}

// Necessary ECMAScript representation adapter. Existing ryu-js supplies Number
// formatting and process_env supplies canonical numeric-own-key ordering.
fn stringify_json_value(value: &JsoncValue, indent: usize, depth: usize) -> String {
    let (open, close, children): (&str, &str, Vec<String>) = match value.kind {
        7 => return "null".into(),
        8 => return "true".into(),
        9 => return "false".into(),
        10 => return stringify_utf16(&value.string_units),
        11 => {
            let number = value.number.unwrap_or(f64::NAN);
            return if number.is_finite() {
                ryu_js::Buffer::new().format(number).to_owned()
            } else {
                "null".into()
            };
        }
        3 => (
            "[",
            "]",
            value
                .as_array()
                .unwrap()
                .iter()
                .map(|v| stringify_json_value(v, indent, depth + 1))
                .collect(),
        ),
        _ => {
            // Lossy key projection is used only for numeric-index ordering;
            // actual keys retain their original UTF-16 units when emitted.
            let keys: Vec<_> = value
                .properties
                .iter()
                .enumerate()
                .map(|(i, (key, _))| (String::from_utf16_lossy(key), i))
                .collect();
            let entries = crate::utils::process_env::ecmascript_object_entries(
                keys.iter().map(|(key, i)| (key, i)),
            );
            (
                "{",
                "}",
                entries
                    .into_iter()
                    .map(|(_, index)| {
                        let (key, value) = &value.properties[*index];
                        format!(
                            "{}:{}{}",
                            stringify_utf16(key),
                            if indent == 0 { "" } else { " " },
                            stringify_json_value(value, indent, depth + 1)
                        )
                    })
                    .collect(),
            )
        }
    };
    if children.is_empty() {
        return format!("{open}{close}");
    }
    if indent == 0 {
        return format!("{open}{}{close}", children.join(","));
    }
    let padding = " ".repeat(indent * (depth + 1));
    format!(
        "{open}\n{padding}{}\n{}{close}",
        children.join(&format!(",\n{padding}")),
        " ".repeat(indent * depth)
    )
}

// JSON.stringify escapes lone surrogates while emitting valid Unicode pairs.
// serde handles ordinary string escaping; only unrepresentable UTF-16 units
// need an explicit escape between normally serialized Rust-string runs.
fn stringify_utf16(units: &[u16]) -> String {
    let mut output = String::from("\"");
    let mut run = String::new();
    let flush = |output: &mut String, run: &mut String| {
        let encoded = serde_json::to_string(run).expect("string serializes");
        output.push_str(&encoded[1..encoded.len() - 1]);
        run.clear();
    };
    for unit in char::decode_utf16(units.iter().copied()) {
        match unit {
            Ok(character) => run.push(character),
            Err(error) => {
                flush(&mut output, &mut run);
                output.push_str(&format!("\\u{:04x}", error.unpaired_surrogate()));
            }
        }
    }
    flush(&mut output, &mut run);
    output.push('"');
    output
}

/// Maps to: CC `utils/slowOperations.ts#jsonParse:204–211`, no reviver.
/// Validate strict grammar without rejecting JS nonfinite numbers or UTF-16
/// escapes before constructing the same parser's strict-own-property carrier.
pub fn json_parse(text: &str) -> Result<JsoncValue, serde_json::Error> {
    let _: serde::de::IgnoredAny = serde_json::from_str(text)?;
    Ok(crate::utils::json::parse_json_value_after_validation(text))
}

/// Maps to: CC `utils/slowOperations.ts#writeFileSync_DEPRECATED:248-292`.
/// Current consumers pass UTF-8 strings, default mode/flag, and `flush: true`.
/// Keep the ordinary open/write/fsync/close sequence (including symlink targets),
/// rather than the distinct atomic writer in utils/file.ts.
pub fn write_file_sync_deprecated(
    path: &std::path::Path,
    content: &str,
    flush: bool,
) -> std::io::Result<()> {
    use std::io::Write;
    // Node validates paths before opening them. A NUL is an argument error,
    // not errno EIO from a fabricated failed system call.
    if path.as_os_str().to_string_lossy().contains('\0') {
        let received = serde_json::to_string(&path.to_string_lossy()).expect("path string");
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received {received}"
            ),
        ));
    }
    let file_error = |error: std::io::Error, operation: &str| {
        std::io::Error::new(
            error.kind(),
            crate::utils::errors::format_native_file_error(
                &error,
                operation,
                (operation == "open").then_some(path),
            ),
        )
    };
    let mut file = std::fs::File::create(path).map_err(|error| file_error(error, "open"))?;
    let result = file
        .write_all(content.as_bytes())
        .map_err(|error| file_error(error, "write"))
        .and_then(|()| {
            if flush {
                file.sync_all().map_err(|error| file_error(error, "fsync"))
            } else {
                Ok(())
            }
        });
    // CC's finally closes even after write/fsync failure; a close failure wins.
    #[cfg(unix)]
    {
        use std::os::fd::IntoRawFd;
        let fd = file.into_raw_fd();
        if unsafe { libc::close(fd) } != 0 {
            return Err(file_error(std::io::Error::last_os_error(), "close"));
        }
    }
    #[cfg(not(unix))]
    drop(file);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_file_sync_matches_official_truncate_flush_and_symlink() {
        let dir = std::env::temp_dir().join(format!("nyan-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.as_path().join("export.txt");
        std::fs::write(&path, "old longer contents").unwrap();
        write_file_sync_deprecated(&path, "你好\n", true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "你好\n");
        #[cfg(unix)]
        {
            let link = dir.as_path().join("link.txt");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            write_file_sync_deprecated(&link, "linked", true).unwrap();
            assert!(
                std::fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "linked");
        }
        assert!(
            write_file_sync_deprecated(&dir.as_path().join("missing/export.txt"), "", true)
                .is_err()
        );
    }

    #[test]
    fn write_file_errors_match_official_bun_path_validation_and_errno() {
        // Bun fsyncSync/closeSync/writeFileSync(fd) errors have no path.
        for operation in ["write", "fsync", "close"] {
            assert_eq!(
                crate::utils::errors::format_native_file_error(
                    &std::io::Error::from_raw_os_error(libc::EBADF),
                    operation,
                    None
                ),
                format!("EBADF: bad file descriptor, {operation}")
            );
        }
        let path = std::env::temp_dir().join(format!("{}.txt", "x".repeat(260)));
        let error = write_file_sync_deprecated(&path, "", true)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            format!("ENAMETOOLONG: name too long, open '{}'", path.display())
        );
        let error =
            write_file_sync_deprecated(std::path::Path::new("/tmp/nul\0file.txt"), "", true)
                .unwrap_err()
                .to_string();
        assert_eq!(
            error,
            r#"The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received "/tmp/nul\u0000file.txt""#
        );
    }

    #[test]
    fn json_stringify_matches_official_bun_numbers_keys_and_indentation() {
        // CC slowOperations.ts#jsonStringify delegates to JSON.stringify.
        // Bun oracle recorded under terminal-setup-0913/jsonc/slow-oracle.json.
        let value: Value = serde_json::from_str(
            r#"{"10":1.0,"2":1e-7,"z":-0.0,"a":1e20,"b":1e21,"c":18446744073709551615}"#,
        )
        .unwrap();
        assert_eq!(
            json_stringify(&value, 0),
            r#"{"2":1e-7,"10":1,"z":0,"a":100000000000000000000,"b":1e+21,"c":18446744073709552000}"#
        );
        assert_eq!(
            json_stringify(&json!([{"key":"shift+enter"}]), 2),
            "[\n  {\n    \"key\": \"shift+enter\"\n  }\n]"
        );
        assert_eq!(json_stringify(&json!([1]), 99), "[\n          1\n]");
    }

    #[test]
    fn json_parse_matches_official_strict_syntax_nonfinite_and_own_proto() {
        // Strict JSON.parse and tolerant JSONC parse have distinct grammar and
        // ordinary-object __proto__ assignment semantics. Validate first.
        assert_eq!(
            json_parse(r#"[1e999,{"keep":1}]"#).unwrap().to_json(),
            json!([null,{"keep":1}])
        );
        let parsed = json_parse(r#"[{"__proto__":{"key":"v"}}]"#)
            .unwrap()
            .to_json();
        assert_eq!(parsed[0]["__proto__"]["key"], "v");
        for invalid in [
            "[1,,2]",
            "[1,]",
            "// comment\n[]",
            "[] extra",
            "\u{feff}[]",
            "{bad",
            "[1",
        ] {
            assert!(json_parse(invalid).is_err(), "must reject {invalid:?}");
        }
        // Valid JS strings survive Zed's parse/append/stringify path, including
        // lone surrogate property names and values, without replacing a file.
        let parsed = json_parse(r#"["\ud800",{"\udc00":"\ud800"}]"#).unwrap();
        assert_eq!(
            json_stringify(&parsed, 0),
            r#"["\ud800",{"\udc00":"\ud800"}]"#
        );
    }
}
