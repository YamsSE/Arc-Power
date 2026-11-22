fn main() {
    println!("cargo:rerun-if-changed=windows-test-manifest.xml");
    // `generate_context!` embeds the built renderer at compile time. Without
    // this dependency a renderer-only change leaves the old frontend in the
    // binary and produces a distributable that looks new but is not.
    println!("cargo:rerun-if-changed=../tauri-dist");
    // The transitional distribution retains the existing application's admin
    // model. Debug mock development stays unelevated; production privilege
    // separation remains a separate migration gate.
    let attributes = if std::env::var("PROFILE").as_deref() == Ok("release") {
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-test-manifest.xml")))
    } else { tauri_build::Attributes::new() };
    tauri_build::try_build(attributes).expect("Arc Power native resource build failed");
}
