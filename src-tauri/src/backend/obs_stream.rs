//! Native OBS WebSocket service (port of src/main/obs-stream.js).
//! Blocking transport is intentional: every command is a short local RPC.
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};

pub trait ObsTransport: Send {
    fn send(&mut self, text: &str) -> Result<(), String>;
    fn receive(&mut self) -> Result<String, String>;
}

struct WsTransport(tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>);

impl ObsTransport for WsTransport {
    fn send(&mut self, text: &str) -> Result<(), String> {
        self.0.send(tungstenite::Message::text(text.to_owned())).map_err(|error| error.to_string())
    }
    fn receive(&mut self) -> Result<String, String> {
        loop {
            match self.0.read().map_err(|error| error.to_string())? {
                tungstenite::Message::Text(text) => return Ok(text.to_string()),
                tungstenite::Message::Ping(payload) => {
                    self.0.send(tungstenite::Message::Pong(payload)).map_err(|error| error.to_string())?;
                }
                tungstenite::Message::Close(_) => return Err("OBS disconnected".into()),
                _ => {}
            }
        }
    }
}

fn set_stream_timeouts(socket: &tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>) {
    use tungstenite::stream::MaybeTlsStream;
    let timeout = Some(std::time::Duration::from_secs(8));
    match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => { let _ = stream.set_read_timeout(timeout); let _ = stream.set_write_timeout(timeout); }
        MaybeTlsStream::NativeTls(stream) => { let _ = stream.get_ref().set_read_timeout(timeout); let _ = stream.get_ref().set_write_timeout(timeout); }
        _ => {}
    }
}

pub fn auth_response(password: &str, salt: &str, challenge: &str) -> String {
    let secret = Sha256::digest(format!("{password}{salt}").as_bytes());
    let secret = base64::engine::general_purpose::STANDARD.encode(secret);
    let answer = Sha256::digest(format!("{secret}{challenge}").as_bytes());
    base64::engine::general_purpose::STANDARD.encode(answer)
}

#[derive(Clone, Debug, PartialEq)]
struct Ducking {
    enabled: bool,
    target_input_id: Option<String>,
    attenuation_db: f64,
    original_volume: Option<f64>,
    applied_volume: Option<f64>,
}

impl Default for Ducking {
    fn default() -> Self {
        Self { enabled: false, target_input_id: None, attenuation_db: 12.0, original_volume: None, applied_volume: None }
    }
}

pub struct ObsService {
    transport: Option<Box<dyn ObsTransport>>,
    state: String,
    error: Option<String>,
    host: String,
    port: u64,
    protocol: String,
    scene_id: Option<String>,
    scene_name: Option<String>,
    microphone_input_id: Option<String>,
    ducking: Ducking,
    sequence: u64,
    password: Option<String>,
}

impl Default for ObsService {
    fn default() -> Self { Self::new() }
}

impl ObsService {
    pub fn new() -> Self {
        Self {
            transport: None, state: "disconnected".into(), error: None,
            host: "127.0.0.1".into(), port: 4455, protocol: "ws".into(),
            scene_id: None, scene_name: None, microphone_input_id: None,
            ducking: Ducking::default(), sequence: 0, password: None,
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "state": self.state,
            "connected": matches!(self.state.as_str(), "connected" | "streaming"),
            "sceneName": self.scene_name,
            "sceneId": self.scene_id,
            "microphoneMuted": Value::Null,
            "error": self.error,
        })
    }

    fn apply_settings(&mut self, payload: &Value) {
        if let Some(host) = payload.get("host").and_then(Value::as_str).filter(|value| !value.is_empty()) { self.host = host.into(); }
        if let Some(port) = payload.get("port").and_then(Value::as_u64).filter(|port| (1..=65535).contains(port)) { self.port = port; }
        if let Some(protocol) = payload.get("protocol").and_then(Value::as_str).filter(|value| matches!(*value, "ws" | "wss")) { self.protocol = protocol.into(); }
        if let Some(scene) = payload.get("sceneId") { self.scene_id = scene.as_str().map(str::to_owned); }
        if let Some(scene) = payload.get("sceneName") { self.scene_name = scene.as_str().map(str::to_owned); }
        if let Some(input) = payload.get("microphoneInputId") { self.microphone_input_id = input.as_str().map(str::to_owned); }
        if let Some(ducking) = payload.get("ducking").and_then(Value::as_object) {
            if let Some(enabled) = ducking.get("enabled").and_then(Value::as_bool) { self.ducking.enabled = enabled; }
            if let Some(target) = ducking.get("targetInputId") { self.ducking.target_input_id = target.as_str().map(str::to_owned); }
            if let Some(attenuation) = ducking.get("attenuationDb").and_then(Value::as_f64).filter(|value| value.is_finite()) {
                self.ducking.attenuation_db = attenuation.clamp(0.0, 60.0);
            }
        }
    }

    fn send_json(&mut self, value: &Value) -> Result<(), String> {
        let transport = self.transport.as_mut().ok_or("OBS is not connected")?;
        transport.send(&value.to_string())
    }

    fn receive_json(&mut self) -> Result<Value, String> {
        let transport = self.transport.as_mut().ok_or("OBS is not connected")?;
        let text = transport.receive()?;
        serde_json::from_str(&text).map_err(|error| format!("OBS sent invalid JSON: {error}"))
    }

    fn handshake(&mut self) -> Result<(), String> {
        let hello = self.receive_json()?;
        if hello.get("op").and_then(Value::as_u64) != Some(0) {
            return Err("OBS sent an unexpected Hello message".into());
        }
        let authentication = hello.get("d").and_then(|data| data.get("authentication"));
        let mut identify = json!({"rpcVersion": 1});
        if let Some(authentication) = authentication {
            let salt = authentication.get("salt").and_then(Value::as_str).unwrap_or("");
            let challenge = authentication.get("challenge").and_then(Value::as_str).unwrap_or("");
            identify["authentication"] = json!(auth_response(self.password.as_deref().unwrap_or(""), salt, challenge));
        }
        self.send_json(&json!({"op": 1, "d": identify}))?;
        let identified = self.receive_json()?;
        if identified.get("op").and_then(Value::as_u64) != Some(2) {
            return Err("OBS authentication failed".into());
        }
        self.state = "connected".into();
        self.error = None;
        Ok(())
    }

    fn request(&mut self, request_type: &str, request_data: Value) -> Result<Value, String> {
        self.sequence += 1;
        let request_id = format!("{}-{:032x}", self.sequence, rand::random::<u128>());
        self.send_json(&json!({
            "op": 6,
            "d": {"requestType": request_type, "requestId": request_id, "requestData": request_data},
        }))?;
        loop {
            let payload = self.receive_json()?;
            if payload.get("op").and_then(Value::as_u64) != Some(7) { continue; }
            let data = payload.get("d").cloned().unwrap_or(Value::Null);
            if data.get("requestId").and_then(Value::as_str) != Some(request_id.as_str()) { continue; }
            if data.get("requestStatus").and_then(|status| status.get("result")).and_then(Value::as_bool) == Some(false) {
                return Err(data.get("requestStatus").and_then(|status| status.get("comment")).and_then(Value::as_str)
                    .unwrap_or("OBS request failed").to_owned());
            }
            return Ok(data.get("responseData").cloned().unwrap_or_else(|| json!({})));
        }
    }

    pub fn connect(&mut self, payload: &Value, password: Option<&str>) -> Result<Value, String> {
        self.apply_settings(payload);
        if let Some(password) = payload.get("password").and_then(Value::as_str).filter(|value| value.len() <= 512) {
            self.password = Some(password.to_owned());
        } else if let Some(password) = password {
            self.password = Some(password.to_owned());
        }
        let url = format!("{}://{}:{}", self.protocol, self.host, self.port);
        self.state = "connecting".into();
        self.error = None;
        match tungstenite::connect(url.as_str()) {
            Ok((socket, _)) => {
                set_stream_timeouts(&socket);
                self.transport = Some(Box::new(WsTransport(socket)));
                match self.handshake() {
                    Ok(()) => {
                        if let Ok(data) = self.request("GetCurrentProgramScene", json!({})) {
                            self.scene_id = data.get("sceneUuid").and_then(Value::as_str).map(str::to_owned);
                            self.scene_name = data.get("sceneName").and_then(Value::as_str).map(str::to_owned);
                        }
                        Ok(self.status())
                    }
                    Err(error) => {
                        self.transport = None;
                        self.state = "error".into();
                        self.error = Some(error.clone());
                        Err(error)
                    }
                }
            }
            Err(error) => {
                self.state = "error".into();
                self.error = Some("OBS connection failed".into());
                Err(error.to_string())
            }
        }
    }

    pub fn disconnect(&mut self) -> Value {
        let _ = self.restore_ducking();
        self.transport = None;
        self.state = "disconnected".into();
        self.error = None;
        self.status()
    }

    pub fn scenes(&mut self) -> Result<Value, String> {
        let data = self.request("GetSceneList", json!({}))?;
        Ok(Value::Array(data.get("scenes").and_then(Value::as_array).into_iter().flatten().filter_map(|scene| {
            Some(json!({"id": scene.get("sceneUuid")?.as_str()?, "name": scene.get("sceneName")?.as_str()?}))
        }).collect()))
    }

    pub fn set_scene(&mut self, payload: &Value) -> Result<Value, String> {
        let mut data = Map::new();
        if let Some(id) = payload.get("sceneId").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            data.insert("sceneUuid".into(), json!(id));
            self.scene_id = Some(id.into());
        } else if let Some(name) = payload.get("sceneName").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            data.insert("sceneName".into(), json!(name));
            self.scene_name = Some(name.into());
        }
        self.request("SetCurrentProgramScene", Value::Object(data))?;
        self.scene_id = payload.get("sceneId").and_then(Value::as_str).map(str::to_owned);
        self.scene_name = payload.get("sceneName").and_then(Value::as_str).map(str::to_owned);
        Ok(self.status())
    }

    pub fn start_stream(&mut self) -> Result<Value, String> {
        self.request("StartStream", json!({}))?;
        self.state = "streaming".into();
        Ok(self.status())
    }

    pub fn stop_stream(&mut self) -> Result<Value, String> {
        let _ = self.restore_ducking();
        self.request("StopStream", json!({}))?;
        self.state = "connected".into();
        Ok(self.status())
    }

    pub fn set_microphone_mute(&mut self, payload: &Value) -> Result<Value, String> {
        let input = payload.get("inputId").and_then(Value::as_str).map(str::to_owned)
            .or_else(|| self.microphone_input_id.clone()).ok_or("Choose an OBS microphone input first")?;
        let muted = payload.get("muted").and_then(Value::as_bool) == Some(true);
        self.request("SetInputMute", json!({"inputUuid": input, "inputMuted": muted}))?;
        Ok(json!({"muted": muted}))
    }

    pub fn duck(&mut self) -> Result<Value, String> {
        let target = self.ducking.target_input_id.clone().filter(|value| !value.is_empty());
        if !self.ducking.enabled || target.is_none() { return Ok(json!({"applied": false})); }
        let data = self.request("GetInputVolume", json!({"inputUuid": target.as_deref().unwrap()}))?;
        let original = data.get("inputVolumeDb").and_then(Value::as_f64)
            .filter(|value| value.is_finite()).ok_or("OBS did not return a valid input volume")?;
        let applied = (original - self.ducking.attenuation_db.max(0.0)).clamp(-100.0, 26.0);
        self.request("SetInputVolume", json!({
            "inputUuid": target.as_deref().unwrap(), "inputVolumeDb": applied, "inputVolumeMul": 1,
        }))?;
        self.ducking.original_volume = Some(original);
        self.ducking.applied_volume = Some(applied);
        Ok(json!({"applied": true, "originalVolume": original, "appliedVolume": applied}))
    }

    pub fn restore_ducking(&mut self) -> Value {
        let (Some(target), Some(original)) = (self.ducking.target_input_id.clone(), self.ducking.original_volume) else {
            return json!({"restored": false});
        };
        match self.request("SetInputVolume", json!({"inputUuid": target, "inputVolumeDb": original, "inputVolumeMul": 1})) {
            Ok(_) => {
                self.ducking.applied_volume = None;
                self.ducking.original_volume = None;
                json!({"restored": true, "originalVolume": original})
            }
            Err(error) => json!({"restored": false, "error": error}),
        }
    }

    #[cfg(test)]
    fn connect_for_test(&mut self, payload: &Value, password: Option<&str>) -> Result<Value, String> {
        self.apply_settings(payload);
        self.password = password.map(str::to_owned);
        self.state = "connecting".into();
        self.handshake()?;
        Ok(self.status())
    }
}

pub fn service() -> &'static Mutex<ObsService> {
    static SERVICE: OnceLock<Mutex<ObsService>> = OnceLock::new();
    SERVICE.get_or_init(|| Mutex::new(ObsService::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Script {
        queued: VecDeque<String>,
    }
    impl ObsTransport for Script {
        fn send(&mut self, text: &str) -> Result<(), String> {
            let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
            if value.get("op").and_then(Value::as_u64) == Some(6) {
                let request_id = value["d"]["requestId"].as_str().unwrap_or_default();
                let data = match value["d"]["requestType"].as_str().unwrap_or("") {
                    "GetSceneList" => json!({"scenes": [{"sceneUuid": "s1", "sceneName": "Scene One"}]}),
                    "GetCurrentProgramScene" => json!({"sceneUuid": "s1", "sceneName": "Scene One"}),
                    "GetInputVolume" => json!({"inputVolumeDb": -10.0}),
                    _ => json!({}),
                };
                self.queued.push_back(json!({"op": 7, "d": {
                    "requestId": request_id,
                    "requestStatus": {"result": true, "code": 100},
                    "responseData": data,
                }}).to_string());
            }
            Ok(())
        }
        fn receive(&mut self) -> Result<String, String> { self.queued.pop_front().ok_or_else(|| "no scripted response".into()) }
    }

    fn scripted(auth: bool) -> Box<Script> {
        let mut queued = VecDeque::new();
        queued.push_back(if auth {
            json!({"op": 0, "d": {"authentication": {"salt": "salt", "challenge": "challenge"}}}).to_string()
        } else {
            json!({"op": 0, "d": {}}).to_string()
        });
        queued.push_back(json!({"op": 2, "d": {}}).to_string());
        Box::new(Script { queued })
    }

    #[test]
    fn auth_response_matches_obs_algorithm() {
        assert_eq!(auth_response("password", "salt", "challenge"), "zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=");
    }

    #[test]
    fn connect_auth_and_requests_roundtrip() {
        let mut transport = scripted(true);
        let mut service = ObsService::new();
        service.transport = Some(Box::new(Script { queued: std::mem::take(&mut transport.queued) }));
        let status = service.connect_for_test(&json!({}), Some("password"));
        assert!(status.is_ok(), "{status:?}");
        assert_eq!(service.state, "connected");
        assert_eq!(service.scenes().unwrap()[0]["name"], "Scene One");
        service.start_stream().unwrap();
        assert_eq!(service.state, "streaming");
        service.stop_stream().unwrap();
        assert_eq!(service.state, "connected");
    }

    #[test]
    fn duck_and_restore_use_the_target_input() {
        let mut transport = scripted(false);
        let mut service = ObsService::new();
        service.transport = Some(Box::new(Script { queued: std::mem::take(&mut transport.queued) }));
        service.connect_for_test(&json!({"ducking": {"enabled": true, "targetInputId": "mic", "attenuationDb": 12}}), None).unwrap();
        let ducked = service.duck().unwrap();
        assert_eq!(ducked["applied"], true);
        assert_eq!(ducked["appliedVolume"], -22.0);
        assert_eq!(service.restore_ducking()["restored"], true);
    }
}
