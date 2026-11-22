//! Native backend components. Modules here must not depend on a JavaScript runtime.
pub mod backend;
// The webview role classifier is shared by the host shell, the tray and the
// native recording hub's event fan-out, so the library needs it too. Only
// `role` is reachable from the library; the rest belongs to the binary shell.
#[allow(dead_code)]
pub(crate) mod roles;
