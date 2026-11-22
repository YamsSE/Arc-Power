//! The existing frontend's lossless tagged-value contract, independent of Electron.
//! Keep special JavaScript values distinct; converting undefined to null can change
//! the meaning of a GPU-setting patch.
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub const MAX_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub enum WireValue {
    Undefined,
    Null,
    Bool(bool),
    String(String),
    Number(serde_json::Number),
    SpecialNumber(String),
    BigInt(String),
    Array(Vec<WireValue>),
    Object(Vec<(String, WireValue)>),
}

fn safe_key(key: &str) -> bool {
    !matches!(key, "__proto__" | "constructor" | "prototype")
}

fn bigint(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'))
}

pub fn decode(value: &Value) -> Result<WireValue, String> { decode_at(value, 0) }

fn decode_at(value: &Value, depth: usize) -> Result<WireValue, String> {
    if depth > MAX_DEPTH { return Err("Wire nesting limit exceeded".into()); }
    let object = value.as_object().ok_or("Invalid wire value")?;
    if object.keys().any(|key| key != "t" && key != "v") { return Err("Invalid wire value".into()); }
    let tag = object.get("t").and_then(Value::as_str).ok_or("Missing wire tag")?;
    if matches!(tag, "undefined" | "null") {
        if object.contains_key("v") { return Err("Unexpected wire payload".into()); }
        return Ok(if tag == "undefined" { WireValue::Undefined } else { WireValue::Null });
    }
    let payload = object.get("v").ok_or("Missing wire payload")?;
    Ok(match tag {
        "boolean" => WireValue::Bool(payload.as_bool().ok_or("Invalid boolean wire payload")?),
        "string" => WireValue::String(payload.as_str().ok_or("Invalid string wire payload")?.into()),
        "number" => match payload {
            Value::Number(number) => WireValue::Number(number.clone()),
            Value::String(number) if matches!(number.as_str(), "NaN" | "Infinity" | "-Infinity" | "-0") => WireValue::SpecialNumber(number.clone()),
            _ => return Err("Invalid number wire payload".into()),
        },
        "bigint" => {
            let text = payload.as_str().filter(|text| bigint(text)).ok_or("Invalid bigint wire payload")?;
            WireValue::BigInt(text.into())
        }
        "array" => WireValue::Array(payload.as_array().ok_or("Invalid array wire payload")?.iter()
            .map(|value| decode_at(value, depth + 1)).collect::<Result<_, _>>()?),
        "object" => {
            let mut seen = HashSet::new();
            let mut entries = Vec::new();
            for pair in payload.as_array().ok_or("Invalid object wire payload")? {
                let pair = pair.as_array().filter(|pair| pair.len() == 2).ok_or("Invalid wire object key")?;
                let key = pair[0].as_str().filter(|key| safe_key(key)).ok_or("Invalid wire object key")?;
                if !seen.insert(key) { return Err("Invalid wire object key".into()); }
                entries.push((key.into(), decode_at(&pair[1], depth + 1)?));
            }
            WireValue::Object(entries)
        }
        _ => return Err("Invalid wire payload".into()),
    })
}

/// Rebuild the tagged transport form of a decoded wire value. This is lossless
/// for `undefined`, non-finite numbers and bigint, so native relays can forward
/// renderer values without reducing them through ordinary JSON.
pub fn tagged(value: &WireValue) -> Value {
    match value {
        WireValue::Undefined => json!({"t":"undefined"}),
        WireValue::Null => json!({"t":"null"}),
        WireValue::Bool(value) => json!({"t":"boolean", "v":value}),
        WireValue::String(value) => json!({"t":"string", "v":value}),
        WireValue::Number(value) => json!({"t":"number", "v":value}),
        WireValue::SpecialNumber(value) => json!({"t":"number", "v":value}),
        WireValue::BigInt(value) => json!({"t":"bigint", "v":value}),
        WireValue::Array(values) => json!({"t":"array", "v":values.iter().map(tagged).collect::<Vec<_>>()}),
        WireValue::Object(values) => json!({"t":"object", "v":values.iter()
            .map(|(key, value)| json!([key, tagged(value)])).collect::<Vec<_>>()}),
    }
}

/// Encodes only ordinary JSON results. Special values must remain WireValue.
pub fn encode_json(value: &Value) -> Result<Value, String> { encode_json_at(value, 0) }

fn encode_json_at(value: &Value, depth: usize) -> Result<Value, String> {
    if depth > MAX_DEPTH { return Err("Wire nesting limit exceeded".into()); }
    Ok(match value {
        Value::Null => json!({"t":"null"}),
        Value::Bool(_) => json!({"t":"boolean", "v":value}),
        Value::String(_) => json!({"t":"string", "v":value}),
        Value::Number(_) => json!({"t":"number", "v":value}),
        Value::Array(values) => json!({"t":"array", "v":values.iter().map(|value| encode_json_at(value, depth + 1)).collect::<Result<Vec<_>, _>>()?}),
        Value::Object(values) => {
            let mut pairs = Vec::new();
            for (key, value) in values {
                if !safe_key(key) { return Err("Unsafe wire key".into()); }
                pairs.push(json!([key, encode_json_at(value, depth + 1)?]));
            }
            json!({"t":"object", "v":pairs})
        }
    })
}

impl WireValue {
    /// Reject values that JSON cannot express instead of silently losing them.
    pub fn into_json(self) -> Result<Value, String> {
        Ok(match self {
            Self::Null => Value::Null,
            Self::Bool(value) => value.into(),
            Self::String(value) => value.into(),
            Self::Number(value) => Value::Number(value),
            Self::Array(values) => Value::Array(values.into_iter().map(Self::into_json).collect::<Result<_, _>>()?),
            Self::Object(values) => Value::Object(values.into_iter().map(|(key, value)| Ok((key, value.into_json()?))).collect::<Result<Map<_, _>, String>>()?),
            _ => return Err("Wire value is not ordinary JSON".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn setting_patch_preserves_missing_null_and_nonfinite_distinction() {
        assert_eq!(decode(&json!({"t":"undefined"})).unwrap(), WireValue::Undefined);
        assert_eq!(decode(&json!({"t":"null"})).unwrap(), WireValue::Null);
        for number in ["NaN", "Infinity", "-Infinity", "-0"] {
            assert_eq!(decode(&json!({"t":"number","v":number})).unwrap(), WireValue::SpecialNumber(number.into()));
        }
        assert!(WireValue::Undefined.into_json().is_err());
        assert!(WireValue::SpecialNumber("NaN".into()).into_json().is_err());
    }
    #[test]
    fn ordinary_nested_results_round_trip() {
        let value = json!({"profiles":[{"name":"B580","settings":{"coreOffsetMHz":50,"vfCurve":null}}],"enabled":true});
        assert_eq!(decode(&encode_json(&value).unwrap()).unwrap().into_json().unwrap(), value);
    }
    #[test]
    fn rejects_ambiguous_or_unsafe_input() {
        for value in [json!({"t":"null","v":null}), json!({"t":"boolean","v":1}),
            json!({"t":"bigint","v":"01"}), json!({"t":"bigint","v":"+1"}),
            json!({"t":"number","v":"50"}), json!({"t":"string","v":"x","extra":1}),
            json!({"t":"object","v":[["x",{"t":"null"}],["x",{"t":"null"}]]}),
            json!({"t":"object","v":[["constructor",{"t":"null"}]]})] {
            assert!(decode(&value).is_err(), "{value}");
        }
        for value in ["0", "-0", "9007199254740993", "-123"] {
            assert!(matches!(decode(&json!({"t":"bigint","v":value})).unwrap(), WireValue::BigInt(_)));
        }
    }
    #[test]
    fn bounds_nesting_at_frontend_contract_limit() {
        let mut value = json!({"t":"null"});
        for _ in 0..MAX_DEPTH { value = json!({"t":"array","v":[value]}); }
        assert!(decode(&value).is_ok());
        assert!(decode(&json!({"t":"array","v":[value]})).is_err());
    }
}
