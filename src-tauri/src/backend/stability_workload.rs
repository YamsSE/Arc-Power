//! Bounded D3D11 Stability Lab workload matching the Koffi reference.
//! Adapter selection is pure and fail-closed; the GPU resources are created
//! only by the native Windows path and are never touched by tests.
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const TEXTURE_WIDTH: u32 = 3072;
const TEXTURE_HEIGHT: u32 = 3072;
const TEXTURE_BYTES: u64 = TEXTURE_WIDTH as u64 * TEXTURE_HEIGHT as u64 * 4;
const MAX_TEXTURE_COUNT: usize = 512;
/// The plan is now sized by **watts**, and the measurements say where watts do
/// not come from.
///
/// Run f099ca9e (16 x 576-iteration passes + 576 copies) read **106 W mean /
/// 112 W max / 60 C** with the 3-D node at 93 % and the D3DKMT copy node at
/// **13.6 %**. The previous run (same draws, 64 copies) held a 207 ms period;
/// this one held 229 ms. 512 extra copies of 36 MiB are 36.8 GB of DRAM traffic
/// arriving in 22 ms, i.e. an implied 1.7 TB/s on a 456 GB/s part — impossible.
/// The copies are not moving the memory they claim: the driver fast-paths them,
/// so `CopyResource` cannot be the load, and the earlier 576-copy "copy-bound"
/// model was wrong on this driver.
///
/// The shader was not collapsed: 16 x 9,437,184 px x 576 iterations x ~20 FLOP
/// is ~1.7 TFLOP inside a ~200 ms draw phase, ~8.7 TFLOP/s, i.e. already ~64 %
/// of the B580's ~13.7 TFLOP/s FP32 peak. An ALU-only load that high is the most
/// efficient shape this part can run, which is why it draws only ~106 W. More
/// shader iterations lengthen the period at the same watts.
///
/// So the memory load moves *into the draw path*, where it cannot be
/// fast-pathed: each pass samples a source render target (`Texture2D.Load`, a
/// real 36 MiB read), blends into a different target (the ROP reads and writes
/// another 72 MiB), and the target rotates every pass. That is 108 MiB of DRAM
/// per pass — a FurMark-shaped fill/blend load with a light ILP-4 shader on top,
/// so neither the ALU nor the memory path is starved.
///
/// Sizing (3072x3072 RGBA = 36 MiB per target):
/// - 384 passes x 108 MiB = 40.5 GiB (43.5 GB) of DRAM per submission;
/// - at the 210 GB/s a blend-bound fill sustains (~46 % of peak) that is a
///   ~207 ms period, ~145 submissions per 30 s;
/// - the shader is 384 x 9,437,184 px x 8 iterations x 24 FLOP = 0.70 TFLOP,
///   ~51-80 ms, so the memory path, not the ALU, sets the period.
const CLEARS_PER_TICK: usize = 2;
/// A token memory path, kept only so the workload still issues copies. They are
/// demonstrably not the load on this driver (see above).
const COPIES_PER_TICK: usize = 64;
const DRAW_PASSES_PER_TICK: usize = 384;
/// Loop count of the pixel shader. The shader source is generated from it so the
/// plan and the HLSL cannot drift apart. Deliberately light: this workload is
/// fill/blend-bound, and a heavier shader would trade the memory load away.
const SHADER_ITERATIONS: usize = 8;
/// Four independent `float3` chains, one multiply-add each per iteration:
/// 4 x 3 x 2 FLOP.
const SHADER_FLOPS_PER_ITERATION: u64 = 24;
/// DRAM a single pass touches, in whole render targets: the sampled source, the
/// blend destination read, and the write.
const PASS_DRAM_MULTIPLIER: u64 = 3;
const PIXELS_PER_PASS: u64 = TEXTURE_WIDTH as u64 * TEXTURE_HEIGHT as u64;
/// Sustainable read+write throughput of a blend-bound fill: 46 % of the B580's
/// 456 GB/s, the band the old copy-bound plan also held. Test-only basis.
#[cfg(test)]
const BLEND_DRAM_BYTES_PER_SEC: f64 = 210.0e9;
#[cfg(test)]
const DRAM_PEAK_BYTES_PER_SEC: f64 = 456.0e9;
/// Measured practical ALU throughput of the previous shader (~64 % of peak) and
/// the theoretical peak. Test-only: they bracket the shader's contribution.
#[cfg(test)]
const SHADER_FLOPS_PER_SEC_FLOOR: f64 = 8.7e12;
#[cfg(test)]
const SHADER_FLOPS_PER_SEC_CEILING: f64 = 13.7e12;
const BUSY_RETRY_MS: u64 = 1;
/// Floor on the submission period. One submission already carries hundreds of
/// milliseconds of GPU work, so this never idles a loaded adapter; it only stops
/// an unexpectedly fast batch from spinning the submit thread.
const MIN_SUBMIT_INTERVAL_MS: u64 = 25;

/// The work one submission issues: blended sampled passes for the load, copies
/// for a token memory touch, clears for the target rotation. Pure, so the
/// bandwidth plan is testable without a GPU.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TickWork {
    pub copies: usize,
    pub draws: usize,
    pub clears: usize,
}

impl TickWork {
    pub fn plan(texture_count: usize) -> Self {
        Self {
            copies: if texture_count > 1 { COPIES_PER_TICK } else { 0 },
            draws: DRAW_PASSES_PER_TICK,
            clears: CLEARS_PER_TICK,
        }
    }

    /// DRAM bytes the copies move: each copy reads one full texture and writes
    /// another, so the traffic is twice the copied volume.
    pub fn copy_dram_bytes(&self) -> u64 { self.copies as u64 * TEXTURE_BYTES * 2 }

    /// DRAM bytes the blended, sampled passes move. A pass reads one target
    /// (`Load`), blends into a second (ROP read + write) and writes it back.
    pub fn blend_dram_bytes(&self) -> u64 {
        self.draws as u64 * TEXTURE_BYTES * PASS_DRAM_MULTIPLIER
    }

    /// Shader FLOPs the same passes issue. Used to prove the memory path, not
    /// the ALU, sets the submission period.
    pub fn shader_flops(&self) -> u64 {
        self.draws as u64 * PIXELS_PER_PASS * SHADER_ITERATIONS as u64 * SHADER_FLOPS_PER_ITERATION
    }
}

#[derive(Clone, Debug)]
struct AllocationPlan {
    target_bytes: u64,
    texture_count: usize,
}

#[derive(Clone, Debug)]
struct AllocationSummary {
    target_bytes: u64,
    allocated_bytes: u64,
    complete: bool,
    reason: Option<String>,
}

fn allocation_plan(nominal_bytes: u64) -> AllocationPlan {
    let target_bytes = ((nominal_bytes as u128 * 80 + 99) / 100).min(u64::MAX as u128) as u64;
    let requested = target_bytes.saturating_add(TEXTURE_BYTES - 1) / TEXTURE_BYTES;
    AllocationPlan {
        target_bytes,
        texture_count: requested.min(MAX_TEXTURE_COUNT as u64) as usize,
    }
}

fn allocation_summary(plan: &AllocationPlan, allocated_textures: usize) -> AllocationSummary {
    let allocated_bytes = (allocated_textures as u64).saturating_mul(TEXTURE_BYTES);
    let complete = plan.target_bytes > 0 && allocated_bytes >= plan.target_bytes;
    AllocationSummary {
        target_bytes: plan.target_bytes,
        allocated_bytes,
        complete,
        reason: (!complete).then(|| "the workload could not reach its nominal VRAM target".to_owned()),
    }
}

impl AllocationSummary {
    fn to_json(&self) -> Value {
        json!({
            "targetBytes":self.target_bytes,
            "allocatedBytes":self.allocated_bytes,
            "complete":self.complete,
            "reason":self.reason,
        })
    }
}

pub trait WorkloadController: Send + Sync {
    /// Starts the workload. A refusal is returned as `{started:false,reason}`
    /// so the Stability Lab can stay monitor-only without delegating.
    fn start(&self, target: &Value) -> Result<Value, String>;
    fn stop(&self) -> Result<(), String>;
    fn status(&self) -> Value;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterRow {
    pub luid: Option<String>,
    pub vendor_id: u16,
    pub device_id: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterIdentity {
    pub luid: Option<String>,
    pub vendor_id: Option<u16>,
    pub device_id: Option<u16>,
}

fn field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key).filter(|value| !value.is_null()))
}

fn number_to_u32(value: &Value) -> Option<u32> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 { return None; }
    Some(number as i64 as u32)
}

fn parse_luid_part(text: &str) -> Option<u32> {
    let text = text.trim();
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        if hex.is_empty() || hex.len() > 8 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
        return u32::from_str_radix(hex, 16).ok();
    }
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
    text.parse::<u32>().ok()
}

/// Returns `(high, low)` because DXGI and the renderer key use high:low order.
pub fn normalize_luid(value: &Value) -> Option<(u32, u32)> {
    if let Some(text) = value.as_str() {
        let (high, low) = text.split_once(':')?;
        return Some((parse_luid_part(high)?, parse_luid_part(low)?));
    }
    if let Some(items) = value.as_array() {
        if items.len() < 2 { return None; }
        return Some((number_to_u32(&items[1])?, number_to_u32(&items[0])?));
    }
    if value.is_object() {
        let low = field(value, &["low", "LowPart", "lowPart"]).and_then(number_to_u32)?;
        let high = field(value, &["high", "HighPart", "highPart"]).and_then(number_to_u32)?;
        return Some((high, low));
    }
    None
}

fn normalize_pci_id(value: &Value) -> Option<u16> {
    if let Some(number) = value.as_f64() {
        if !number.is_finite() || number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 { return None; }
        return Some((number as i64 as u32 & 0xffff) as u16);
    }
    let text = value.as_str()?.trim();
    let text = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).unwrap_or(text);
    if text.is_empty() || text.len() > 8 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    u32::from_str_radix(text, 16).ok().map(|value| (value & 0xffff) as u16)
}

pub fn adapter_identity_of(target: &Value) -> AdapterIdentity {
    let physical = target.get("physicalTarget").filter(|value| value.is_object()).unwrap_or(target);
    let luid = field(physical, &["osLuid", "controllerLuid", "luid", "adapterLuid"])
        .and_then(normalize_luid)
        .map(|(high, low)| format!("{high}:{low}"));
    let vendor_id = field(physical, &["pciVendorId", "vendorId"]).and_then(normalize_pci_id);
    let device_id = field(physical, &["pciDeviceId", "deviceId"]).and_then(normalize_pci_id);
    AdapterIdentity { luid, vendor_id, device_id }
}

/// Exact DXGI identity first, then a unique PCI vendor/device pair. Ambiguous
/// or missing identities fail closed instead of falling back to adapter zero.
pub fn choose_adapter(rows: &[AdapterRow], target: &Value) -> Result<usize, String> {
    let wanted = adapter_identity_of(target);
    if wanted.luid.is_none() && (wanted.vendor_id.is_none() || wanted.device_id.is_none()) {
        return Err("the selected GPU has no stable DXGI identity".into());
    }
    if let Some(luid) = wanted.luid.as_deref() {
        let exact: Vec<usize> = rows.iter().enumerate()
            .filter(|(_, row)| row.luid.as_deref() == Some(luid))
            .map(|(index, _)| index).collect();
        if exact.len() == 1 { return Ok(exact[0]); }
        if exact.len() > 1 { return Err("the selected GPU identity is ambiguous".into()); }
    }
    if let (Some(vendor_id), Some(device_id)) = (wanted.vendor_id, wanted.device_id) {
        let pci: Vec<usize> = rows.iter().enumerate()
            .filter(|(_, row)| row.vendor_id == vendor_id && row.device_id == device_id)
            .map(|(index, _)| index).collect();
        if pci.len() == 1 { return Ok(pci[0]); }
    }
    Err("DXGI could not match the selected GPU".into())
}

struct ActiveWorkload {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    adapter_luid: String,
    tick: Arc<AtomicU64>,
    errors: Arc<AtomicU64>,
    draws: Arc<AtomicU64>,
    copies: Arc<AtomicU64>,
    last_error: Arc<Mutex<Option<String>>>,
    allocation: Value,
}

pub struct D3d11Workload {
    active: Mutex<Option<ActiveWorkload>>,
    last: Mutex<Value>,
}

impl D3d11Workload {
    pub fn new() -> Self {
        Self { active: Mutex::new(None), last: Mutex::new(empty_workload_status()) }
    }
}

impl Default for D3d11Workload { fn default() -> Self { Self::new() } }

fn empty_workload_status() -> Value {
    json!({"active":false,"tick":0,"workloadSubmits":0,"workloadErrors":0,
        "workloadDraws":0,"workloadCopies":0,
        "workloadError":null,"workloadThreadFinished":false})
}

fn active_workload_status(active: &ActiveWorkload) -> Value {
    let error = active.last_error.lock().ok().and_then(|error| error.clone());
    json!({
        "active":true,
        "adapterLuid":active.adapter_luid,
        "tick":active.tick.load(Ordering::SeqCst),
        "workloadSubmits":active.tick.load(Ordering::SeqCst),
        "workloadErrors":active.errors.load(Ordering::SeqCst),
        "workloadDraws":active.draws.load(Ordering::SeqCst),
        "workloadCopies":active.copies.load(Ordering::SeqCst),
        "workloadError":error,
        "workloadThreadFinished":active.handle.as_ref().is_some_and(JoinHandle::is_finished),
        "allocation":active.allocation,
    })
}

impl WorkloadController for D3d11Workload {
    fn start(&self, target: &Value) -> Result<Value, String> {
        let _ = self.stop();
        if let Ok(mut last) = self.last.lock() { *last = empty_workload_status(); }
        #[cfg(windows)]
        { Ok(native_start(self, target)) }
        #[cfg(not(windows))]
        {
            let _ = target;
            Ok(json!({"started":false,"reason":"the selected GPU workload is unavailable on this platform"}))
        }
    }

    fn stop(&self) -> Result<(), String> {
        let active = self.active.lock().map_err(|_| "stability workload lock failed")?.take();
        let Some(mut active) = active else { return Ok(()); };
        active.stop.store(true, Ordering::Release);
        let join_failed = active.handle.take().is_some_and(|handle| handle.join().is_err());
        if join_failed {
            active.errors.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut error) = active.last_error.lock() {
                *error = Some("stability workload thread panicked".into());
            }
        }
        let mut last = active_workload_status(&active);
        last["active"] = json!(false);
        last["workloadThreadFinished"] = json!(true);
        if let Ok(mut saved) = self.last.lock() { *saved = last; }
        Ok(())
    }

    fn status(&self) -> Value {
        if let Ok(active) = self.active.lock() {
            if let Some(active) = active.as_ref() { return active_workload_status(active); }
        }
        self.last.lock().map(|last| last.clone()).unwrap_or_else(|_| empty_workload_status())
    }
}

#[cfg(windows)]
fn native_start(workload: &D3d11Workload, target: &Value) -> Value {
    match d3d::build_and_spawn(target) {
        Ok((resources, adapter_luid, device_key)) => {
            let allocation = resources.allocation.to_json();
            let stop = Arc::new(AtomicBool::new(false));
            let tick = Arc::new(AtomicU64::new(0));
            let errors = Arc::new(AtomicU64::new(0));
            let draws = Arc::new(AtomicU64::new(0));
            let copies = Arc::new(AtomicU64::new(0));
            let last_error = Arc::new(Mutex::new(None));
            let thread_stop = stop.clone();
            let thread_tick = tick.clone();
            let thread_errors = errors.clone();
            let thread_draws = draws.clone();
            let thread_copies = copies.clone();
            let thread_last_error = last_error.clone();
            let spawned = thread::Builder::new().name("arc-stability-workload".into())
                .spawn(move || {
                    let mut resources = resources;
                    while !thread_stop.load(Ordering::Acquire) {
                        let submitted_at = std::time::Instant::now();
                        // Counts before this submission: a submit that gets past
                        // the event-query gate means the previous batch has
                        // retired, so these totals are completed (retired) work.
                        // Publishing them proves the 3-D path executes rather
                        // than only being queued.
                        let (retired_draws, retired_copies) = resources.issued();
                        match resources.submit() {
                            d3d::Submit::Submitted => {
                                thread_tick.fetch_add(1, Ordering::SeqCst);
                                thread_draws.store(retired_draws, Ordering::SeqCst);
                                thread_copies.store(retired_copies, Ordering::SeqCst);
                            }
                            // The event query is the submission backpressure.
                            // Re-check immediately after each submit; only a
                            // pending query sleeps, avoiding an artificial
                            // idle gap without busy-spinning.
                            d3d::Submit::Busy => thread::sleep(Duration::from_millis(BUSY_RETRY_MS)),
                            d3d::Submit::Failed(error) => {
                                thread_errors.fetch_add(1, Ordering::SeqCst);
                                if let Ok(mut last_error) = thread_last_error.lock() {
                                    *last_error = Some(error);
                                }
                                break;
                            }
                        }
                        if let Some(idle) = Duration::from_millis(MIN_SUBMIT_INTERVAL_MS)
                            .checked_sub(submitted_at.elapsed())
                        {
                            thread::sleep(idle);
                        }
                    }
                });
            let handle = match spawned {
                Ok(handle) => handle,
                Err(error) => return json!({"started":false,"reason":error.to_string()}),
            };
            let active = ActiveWorkload {
                stop, handle: Some(handle), adapter_luid: adapter_luid.clone(),
                tick, errors, draws, copies, last_error, allocation: allocation.clone(),
            };
            match workload.active.lock() {
                Ok(mut slot) => *slot = Some(active),
                Err(_) => {
                    active.stop.store(true, Ordering::Release);
                    if let Some(handle) = active.handle { let _ = handle.join(); }
                    return json!({"started":false,"reason":"stability workload lock failed"});
                }
            }
            json!({"started":true,"adapterLuid":adapter_luid,"deviceKey":device_key,"allocation":allocation})
        }
        Err(error) => json!({
            "started":false,
            "reason":error.reason,
            "allocation":error.allocation.map(|allocation| allocation.to_json()),
        }),
    }
}

#[cfg(windows)]
mod d3d {
    use super::*;
    use std::ffi::c_void;
    use windows::core::PCSTR;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
    use windows::Win32::Graphics::Direct3D::{
        ID3DBlob, ID3DInclude, D3D_DRIVER_TYPE_UNKNOWN, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11BlendState, ID3D11ClassLinkage, ID3D11DepthStencilView,
        ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11Query,
        ID3D11RenderTargetView, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
        D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
        D3D11_BLEND_DESC, D3D11_BLEND_INV_SRC_ALPHA, D3D11_BLEND_ONE, D3D11_BLEND_OP_ADD,
        D3D11_BLEND_SRC_ALPHA, D3D11_BLEND_ZERO, D3D11_COLOR_WRITE_ENABLE_ALL,
        D3D11_CREATE_DEVICE_FLAG, D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_SDK_VERSION,
        D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ERROR_NOT_FOUND,
    };

    const VERTEX_SHADER: &str = r#"
struct VSOut { float4 position : SV_Position; float2 uv : TEXCOORD0; };
VSOut main(uint vertexId : SV_VertexID) {
  float2 position = vertexId == 0 ? float2(-1, -1) : (vertexId == 1 ? float2(-1, 3) : float2(3, -1));
  VSOut output; output.position = float4(position, 0, 1); output.uv = position * 0.5 + 0.5; return output;
}"#;

    /// The pass shader, generated from the sizing constants so the plan and the
    /// HLSL cannot drift apart. The `Load` is the pass's DRAM read; the blend
    /// state (not the shader) is what turns the write into a read-modify-write.
    pub(super) fn pixel_shader_source() -> String {
        format!(r#"
Texture2D<float4> g_input : register(t0);
struct VSOut {{ float4 position : SV_Position; float2 uv : TEXCOORD0; }};
float4 main(VSOut input) : SV_Target {{
  float4 tex = g_input.Load(int3(int2(input.uv * float2({width}.0, {height}.0)), 0));
  float3 seed = tex.rgb * 0.37 + float3(input.uv, 0.37);
  // Four independent accumulators: with a light loop this keeps the ALU busy
  // without letting it become the bottleneck the memory path is meant to be.
  float3 a = seed;
  float3 b = frac(seed * 1.6180339 + 0.113);
  float3 c = frac(b * 1.7320508 + 0.271);
  float3 d = frac(c * 2.2360679 + 0.419);
  [loop] for (uint i = 0; i < {iterations}; ++i) {{
    a = frac(a * 1.6180339 + 0.6180339);
    b = frac(b * 1.7320508 + 0.7320508);
    c = frac(c * 2.2360679 + 0.2360679);
    d = frac(d * 2.6457513 + 0.6457513);
  }}
  // Alpha 0.25 into a SRC_ALPHA/INV_SRC_ALPHA blend: the ROP folds the pass into
  // the target, so the surface is read as well as written.
  return float4((a + b + c + d) * 0.25, 0.25);
}}"#, width = TEXTURE_WIDTH, height = TEXTURE_HEIGHT, iterations = SHADER_ITERATIONS)
    }

    pub enum Submit { Submitted, Busy, Failed(String) }

    pub struct BuildError {
        pub reason: String,
        pub allocation: Option<AllocationSummary>,
    }

    impl From<String> for BuildError {
        fn from(reason: String) -> Self { Self { reason, allocation: None } }
    }

    impl From<&str> for BuildError {
        fn from(reason: &str) -> Self { Self { reason: reason.to_owned(), allocation: None } }
    }

    pub struct Resources {
        _device: ID3D11Device,
        context: ID3D11DeviceContext,
        query: ID3D11Query,
        vertex: ID3D11VertexShader,
        pixel: ID3D11PixelShader,
        blend: ID3D11BlendState,
        textures: Vec<ID3D11Texture2D>,
        views: Vec<ID3D11RenderTargetView>,
        srvs: Vec<ID3D11ShaderResourceView>,
        viewport: D3D11_VIEWPORT,
        color: [f32; 4],
        tick: usize,
        query_pending: bool,
        work: TickWork,
        issued_draws: u64,
        issued_copies: u64,
        pub(super) allocation: AllocationSummary,
    }

    impl Resources {
        /// Cumulative draws and copies the renderer has issued. The caller
        /// publishes both so a run can prove the 3-D path executes rather than
        /// being queued behind copies forever.
        pub fn issued(&self) -> (u64, u64) { (self.issued_draws, self.issued_copies) }

        pub fn submit(&mut self) -> Submit {
            if self.query_pending {
                let mut complete = 0u32;
                let result = unsafe {
                    self.context.GetData(&self.query, Some(&mut complete as *mut u32 as *mut c_void),
                        4, D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32)
                };
                if let Err(error) = result {
                    return Submit::Failed(format!("D3D11 event query GetData failed (0x{:08x})", error.code().0 as u32));
                }
                if complete == 0 { return Submit::Busy; }
                self.query_pending = false;
            }
            let count = self.textures.len();
            if count == 0 { return Submit::Failed("D3D11 workload has no render targets".into()); }
            let work = self.work;
            for pass in 0..work.copies {
                let source = &self.textures[(pass + self.tick) % count];
                let destination = &self.textures[(pass + self.tick + 1) % count];
                unsafe { self.context.CopyResource(destination, source); }
            }
            unsafe {
                self.context.VSSetShader(&self.vertex, None);
                self.context.PSSetShader(&self.pixel, None);
                self.context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                self.context.RSSetViewports(Some(&[self.viewport]));
                // The blend is what makes each pass a read-modify-write of the
                // whole target: a write-only pass would be compressible and the
                // memory load would vanish again, exactly like the copies did.
                self.context.OMSetBlendState(Some(&self.blend), None, u32::MAX);
            }
            for pass in 0..work.draws {
                let index = (pass + self.tick) % count;
                // Sample one target while rendering another: a render target may
                // not be bound as an SRV at the same time, and the pass needs a
                // real read on top of the blend's read of its own destination.
                let source = self.srvs[(index + 1) % count].clone();
                let view = self.views[index].clone();
                unsafe {
                    self.context.OMSetRenderTargets(Some(&[Some(view)]), None::<&ID3D11DepthStencilView>);
                    self.context.PSSetShaderResources(0, Some(&[Some(source)]));
                    self.context.Draw(3, 0);
                }
            }
            unsafe { self.context.PSSetShaderResources(0, Some(&[None])); }
            for pass in 0..work.clears {
                let view = &self.views[(pass + self.tick) % count];
                unsafe { self.context.ClearRenderTargetView(view, &self.color); }
            }
            // End marks the batch; Flush pushes it to the GPU now, and the next
            // submit polls this query, so the draw queue cannot drain behind a
            // later batch. That fence is what keeps the 3-D node occupied.
            unsafe {
                self.context.End(&self.query);
                self.context.Flush();
            }
            self.query_pending = true;
            self.tick += 1;
            self.issued_draws += work.draws as u64;
            self.issued_copies += work.copies as u64;
            Submit::Submitted
        }
    }

    fn compile(source: &str, entry: &str, entry_pc: PCSTR, target: PCSTR) -> Result<Vec<u8>, String> {
        let mut code: Option<ID3DBlob> = None;
        let mut errors: Option<ID3DBlob> = None;
        let result = unsafe {
            D3DCompile(source.as_ptr().cast(), source.len(),
                windows::core::s!("arc-power-stability.hlsl"), None, None::<&ID3DInclude>,
                entry_pc, target, 0, 0, &mut code, Some(&mut errors))
        };
        if let Err(error) = result {
            let mut message = format!("HLSL {entry} compilation failed (0x{:08x})", error.code().0 as u32);
            if let Some(blob) = errors {
                let pointer = unsafe { blob.GetBufferPointer() } as *const u8;
                let size = unsafe { blob.GetBufferSize() };
                if !pointer.is_null() && size > 0 {
                    let bytes = unsafe { std::slice::from_raw_parts(pointer, size) };
                    let text = String::from_utf8_lossy(bytes);
                    message.push_str(": ");
                    message.push_str(text.trim());
                }
            }
            return Err(message);
        }
        let blob = code.ok_or_else(|| format!("HLSL {entry} compiler returned no bytecode"))?;
        let pointer = unsafe { blob.GetBufferPointer() } as *const u8;
        let size = unsafe { blob.GetBufferSize() };
        if pointer.is_null() || size == 0 { return Err(format!("HLSL {entry} compiler returned no bytecode")); }
        Ok(unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec())
    }

    fn enumerate() -> Result<Vec<(AdapterRow, IDXGIAdapter1)>, String> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
            .map_err(|error| format!("DXGI factory creation failed (0x{:08x})", error.code().0 as u32))?;
        let mut adapters = Vec::new();
        for index in 0..32u32 {
            match unsafe { factory.EnumAdapters1(index) } {
                Ok(adapter) => match unsafe { adapter.GetDesc1() } {
                    Ok(description) => adapters.push((AdapterRow {
                        luid: Some(format!("{}:{}", description.AdapterLuid.HighPart as u32, description.AdapterLuid.LowPart)),
                        vendor_id: description.VendorId as u16,
                        device_id: description.DeviceId as u16,
                    }, adapter)),
                    Err(_) => { /* skip an adapter without a description */ }
                },
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(_) => continue,
            }
        }
        if adapters.is_empty() { return Err("DXGI did not enumerate a graphics adapter".into()); }
        Ok(adapters)
    }

    pub fn build_and_spawn(target: &Value) -> Result<(Resources, String, Option<String>), BuildError> {
        let adapters = enumerate()?;
        let rows: Vec<AdapterRow> = adapters.iter().map(|(row, _)| row.clone()).collect();
        let selected = choose_adapter(&rows, target)?;
        let adapter = &adapters[selected].1;
        let adapter_description = unsafe { adapter.GetDesc1() }
            .map_err(|error| format!("DXGI adapter description failed (0x{:08x})", error.code().0 as u32))?;
        let plan = allocation_plan(adapter_description.DedicatedVideoMemory as u64);
        if plan.target_bytes == 0 || plan.texture_count == 0 {
            return Err(BuildError {
                reason: "selected adapter reports no dedicated VRAM capacity".into(),
                allocation: Some(allocation_summary(&plan, 0)),
            });
        }
        let adapter_luid = rows[selected].luid.clone().unwrap_or_default();
        let device_key = target.get("deviceKey").and_then(Value::as_str).map(str::to_owned);

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        unsafe {
            D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(),
                D3D11_CREATE_DEVICE_FLAG(0), None, D3D11_SDK_VERSION,
                Some(&mut device), None, Some(&mut context))
        }.map_err(|error| format!("D3D11 device creation failed (0x{:08x})", error.code().0 as u32))?;
        let device = device.ok_or("D3D11 device creation returned no device")?;
        let context = context.ok_or("D3D11 device creation returned no context")?;

        let mut query = None;
        let query_desc = D3D11_QUERY_DESC { Query: D3D11_QUERY_EVENT, MiscFlags: 0 };
        unsafe { device.CreateQuery(&query_desc, Some(&mut query)) }
            .map_err(|error| format!("D3D11 event query creation failed (0x{:08x})", error.code().0 as u32))?;
        let query = query.ok_or("D3D11 event query creation returned no query")?;

        let vertex_code = compile(VERTEX_SHADER, "main", windows::core::s!("main"), windows::core::s!("vs_5_0"))?;
        let pixel_source = pixel_shader_source();
        let pixel_code = compile(&pixel_source, "main", windows::core::s!("main"), windows::core::s!("ps_5_0"))?;
        let mut vertex = None;
        let mut pixel = None;
        unsafe {
            device.CreateVertexShader(&vertex_code, None::<&ID3D11ClassLinkage>, Some(&mut vertex))
                .map_err(|error| format!("D3D11 stability shader creation failed (0x{:08x})", error.code().0 as u32))?;
            device.CreatePixelShader(&pixel_code, None::<&ID3D11ClassLinkage>, Some(&mut pixel))
                .map_err(|error| format!("D3D11 stability shader creation failed (0x{:08x})", error.code().0 as u32))?;
        }
        let vertex = vertex.ok_or("D3D11 vertex shader creation returned no shader")?;
        let pixel = pixel.ok_or("D3D11 pixel shader creation returned no shader")?;

        // Alpha blend, not a plain overwrite: the destination read is what makes
        // the pass cost DRAM instead of being a compressible write-only fill.
        let mut blend_desc: D3D11_BLEND_DESC = unsafe { std::mem::zeroed() };
        blend_desc.RenderTarget[0].BlendEnable = true.into();
        blend_desc.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA;
        blend_desc.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        blend_desc.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        blend_desc.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        blend_desc.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ZERO;
        blend_desc.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        blend_desc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL.0 as u8;
        let mut blend = None;
        unsafe { device.CreateBlendState(&blend_desc, Some(&mut blend)) }
            .map_err(|error| format!("D3D11 stability blend state creation failed (0x{:08x})", error.code().0 as u32))?;
        let blend = blend.ok_or("D3D11 stability blend state creation returned no state")?;

        let description = D3D11_TEXTURE2D_DESC {
            Width: TEXTURE_WIDTH,
            Height: TEXTURE_HEIGHT,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32 | D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut textures = Vec::with_capacity(plan.texture_count);
        let mut views = Vec::with_capacity(plan.texture_count);
        let mut srvs = Vec::with_capacity(plan.texture_count);
        let mut allocation_error = None;
        for _ in 0..plan.texture_count {
            let mut texture = None;
            if let Err(error) = unsafe { device.CreateTexture2D(&description, None, Some(&mut texture)) } {
                allocation_error = Some(format!("D3D11 render target creation failed (0x{:08x})", error.code().0 as u32));
                break;
            }
            let Some(texture) = texture else {
                allocation_error = Some("D3D11 render target creation returned no texture".into());
                break;
            };
            let mut view = None;
            if let Err(error) = unsafe { device.CreateRenderTargetView(&texture, None, Some(&mut view)) } {
                allocation_error = Some(format!("D3D11 render view creation failed (0x{:08x})", error.code().0 as u32));
                break;
            }
            let Some(view) = view else {
                allocation_error = Some("D3D11 render view creation returned no view".into());
                break;
            };
            let mut srv = None;
            if let Err(error) = unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut srv)) } {
                allocation_error = Some(format!("D3D11 stability view creation failed (0x{:08x})", error.code().0 as u32));
                break;
            }
            let Some(srv) = srv else {
                allocation_error = Some("D3D11 stability view creation returned no view".into());
                break;
            };
            textures.push(texture);
            views.push(view);
            srvs.push(srv);
        }
        if textures.is_empty() {
            return Err(BuildError {
                reason: allocation_error.unwrap_or_else(|| "D3D11 could not allocate any stability render targets".into()),
                allocation: Some(allocation_summary(&plan, 0)),
            });
        }
        let mut allocation = allocation_summary(&plan, textures.len());
        if !allocation.complete {
            if let Some(reason) = allocation_error { allocation.reason = Some(reason); }
        }
        let work = TickWork::plan(textures.len());

        let resources = Resources {
            _device: device,
            context,
            query,
            vertex,
            pixel,
            blend,
            textures,
            views,
            srvs,
            viewport: D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: TEXTURE_WIDTH as f32,
                Height: TEXTURE_HEIGHT as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            },
            color: [0.2, 0.36, 0.62, 1.0],
            tick: 0,
            query_pending: false,
            work,
            issued_draws: 0,
            issued_copies: 0,
            allocation,
        };
        Ok((resources, adapter_luid, device_key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<AdapterRow> {
        vec![
            AdapterRow { luid: Some("10:20".into()), vendor_id: 0x8086, device_id: 0x56a0 },
            AdapterRow { luid: Some("30:40".into()), vendor_id: 0x10de, device_id: 0x2684 },
            AdapterRow { luid: Some("50:60".into()), vendor_id: 0x10de, device_id: 0x2684 },
        ]
    }

    #[test]
    fn luid_parsing_accepts_renderer_decimal_hex_array_and_object_forms() {
        assert_eq!(normalize_luid(&json!("10:20")), Some((10, 20)));
        assert_eq!(normalize_luid(&json!("0x0000000a:0x00000014")), Some((10, 20)));
        assert_eq!(normalize_luid(&json!([20, 10])), Some((10, 20)));
        assert_eq!(normalize_luid(&json!({"low":20,"high":10})), Some((10, 20)));
        assert_eq!(normalize_luid(&json!({"LowPart":20,"HighPart":10})), Some((10, 20)));
        assert_eq!(normalize_luid(&json!("not-a-luid")), None);
        assert_eq!(normalize_luid(&json!([1])), None);
    }

    #[test]
    fn adapter_selection_prefers_luid_then_unique_pci_and_fails_closed() {
        let rows = rows();
        assert_eq!(choose_adapter(&rows, &json!({"luid":"30:40"})).unwrap(), 1);
        assert_eq!(choose_adapter(&rows, &json!({"physicalTarget":{"osLuid":"0x0000000a:0x00000014"}})).unwrap(), 0);
        assert_eq!(choose_adapter(&rows, &json!({"pciVendorId":"0x8086","pciDeviceId":"0x56a0"})).unwrap(), 0);
        assert_eq!(choose_adapter(&rows, &json!({"pciVendorId":0x8086,"pciDeviceId":0x56a0})).unwrap(), 0);
        assert_eq!(choose_adapter(&rows, &json!({"pciVendorId":"0x10de","pciDeviceId":"0x2684"})).unwrap_err(),
            "DXGI could not match the selected GPU");
        assert_eq!(choose_adapter(&rows, &json!({"pciVendorId":"0x1234","pciDeviceId":"0x5678"})).unwrap_err(),
            "DXGI could not match the selected GPU");
        assert_eq!(choose_adapter(&rows, &json!({})).unwrap_err(),
            "the selected GPU has no stable DXGI identity");
    }

    #[test]
    fn duplicate_luid_is_ambiguous_even_when_pci_would_be_unique() {
        let rows = vec![
            AdapterRow { luid: Some("1:2".into()), vendor_id: 0x8086, device_id: 0x56a0 },
            AdapterRow { luid: Some("1:2".into()), vendor_id: 0x8086, device_id: 0x56a0 },
        ];
        assert_eq!(choose_adapter(&rows, &json!({"luid":"1:2","pciVendorId":0x8086,"pciDeviceId":0x56a0})).unwrap_err(),
            "the selected GPU identity is ambiguous");
    }

    #[test]
    fn workload_status_is_clear_when_no_workload_is_active() {
        let workload = D3d11Workload::new();
        assert_eq!(workload.status(), json!({
            "active":false,"tick":0,"workloadSubmits":0,"workloadErrors":0,
            "workloadDraws":0,"workloadCopies":0,
            "workloadError":null,"workloadThreadFinished":false
        }));
        assert!(workload.stop().is_ok());
    }

    #[test]
    fn every_submission_plans_draw_work_for_the_3d_node_and_copy_work_for_bandwidth() {
        let work = TickWork::plan(283);
        assert_eq!(work.draws, DRAW_PASSES_PER_TICK);
        assert_eq!(work.copies, COPIES_PER_TICK);
        assert!(work.draws > 0, "a copy-only submission leaves the 3-D node idle");
        assert!(work.copies > 0, "the workload still touches the copy path");
        // The draw path, not CopyResource, now carries the memory load: the
        // copies are demonstrably fast-pathed on this driver (see the constants).
        assert!(work.blend_dram_bytes() > work.copy_dram_bytes() * 8,
            "the blended passes must dominate the DRAM traffic");
        assert!(work.clears > 0);
        assert_eq!(TickWork::plan(1).copies, 0, "one texture cannot copy onto itself");
        assert!(MIN_SUBMIT_INTERVAL_MS < 600, "the rate floor is inside one sample");
    }

    #[test]
    fn the_draw_plan_sizes_a_blended_fill_run_for_half_of_peak_bandwidth() {
        let work = TickWork::plan(283);
        let dram = work.blend_dram_bytes();
        assert_eq!(dram, 384 * TEXTURE_BYTES * 3, "the plan arithmetic is the contract");
        // Two independent limits: the memory path and the ALU. The slower one
        // sets the period, so the memory path must be the slower one.
        let dram_ms = dram as f64 / BLEND_DRAM_BYTES_PER_SEC * 1000.0;
        let alu_ms_slowest = work.shader_flops() as f64 / SHADER_FLOPS_PER_SEC_FLOOR * 1000.0;
        let alu_ms_fastest = work.shader_flops() as f64 / SHADER_FLOPS_PER_SEC_CEILING * 1000.0;
        let period_ms = dram_ms.max(alu_ms_slowest);
        let gbps = dram as f64 / (period_ms / 1000.0) / 1e9;
        // 40-50 % of the B580's 456 GB/s: the band a stress test has to reach.
        assert!((182.0..=228.0).contains(&gbps),
            "expected 40-50 % of 456 GB/s, got {gbps:.1} GB/s");
        assert!((gbps / (DRAM_PEAK_BYTES_PER_SEC / 1e9) * 100.0) >= 40.0);
        // The shader must stay under the memory time at both ALU rates, or the
        // run trades the memory load away for ALU work again.
        assert!(alu_ms_fastest < dram_ms && alu_ms_slowest < dram_ms,
            "ALU ({alu_ms_fastest:.0}-{alu_ms_slowest:.0} ms) must fit inside the memory time ({dram_ms:.0} ms)");
        // Enough submissions per run to be statistical, and the floor stays a
        // floor: real work is dozens of times above it.
        assert!(30_000.0 / period_ms >= 100.0, "too few submissions per run");
        assert!(MIN_SUBMIT_INTERVAL_MS as f64 * 4.0 <= period_ms, "the floor must not dominate the period");
    }

    #[test]
    #[cfg(windows)]
    fn the_pixel_shader_iteration_count_comes_from_the_sizing_constant() {
        let source = d3d::pixel_shader_source();
        assert!(source.contains(&format!("i < {SHADER_ITERATIONS};")),
            "the HLSL loop count must come from SHADER_ITERATIONS, not a literal");
        assert!(source.contains("g_input.Load"), "the pass must read a source target");
        assert!(source.contains("float2(3072.0, 3072.0)"), "the Load must use the real target size");
        // Four independent accumulators, or the ALU time is a latency guess.
        for name in ["float3 a", "float3 b", "float3 c", "float3 d"] {
            assert!(source.contains(name), "missing independent chain {name}");
        }
    }

    #[test]
    fn allocation_plan_targets_eighty_percent_of_nominal_vram() {
        let plan = allocation_plan(12_000_000_000);
        assert_eq!(plan.target_bytes, 9_600_000_000);
        assert!((plan.texture_count as u64 * TEXTURE_BYTES - plan.target_bytes) < TEXTURE_BYTES);
        let actual = plan.texture_count as u64 * TEXTURE_BYTES;
        assert!((actual as f64 / 12_000_000_000.0 - 0.8).abs() < 0.01);
    }

    #[test]
    fn allocation_summary_marks_partial_and_zero_allocations_as_failures() {
        let plan = allocation_plan(12_000_000_000);
        let partial = allocation_summary(&plan, 100);
        assert_eq!(partial.allocated_bytes, 100 * TEXTURE_BYTES);
        assert!(!partial.complete);
        assert!(partial.reason.is_some());

        let none = allocation_summary(&plan, 0);
        assert_eq!(none.allocated_bytes, 0);
        assert!(!none.complete);
        assert!(none.reason.is_some());

        let no_capacity = allocation_summary(&allocation_plan(0), 0);
        assert!(!no_capacity.complete);
        assert!(no_capacity.reason.is_some());
    }

    #[test]
    fn allocation_plan_never_exceeds_the_texture_cap() {
        let plan = allocation_plan(u64::MAX);
        assert_eq!(plan.texture_count, MAX_TEXTURE_COUNT);
        assert!(!allocation_summary(&plan, plan.texture_count).complete);
    }
}
