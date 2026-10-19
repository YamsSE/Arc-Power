@echo off
setlocal
set "ROOT=%~dp0"
set "OUT=%ROOT%..\..\.codex\task-artifacts\sharpening-render-proof"
if not exist "%OUT%" mkdir "%OUT%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cl /nologo /EHsc /std:c++17 /O2 /W4 /Fo:"%OUT%\native-sharpening-probe-dx12.obj" "%ROOT%probe-dx12.cpp" /Fe:"%OUT%\native-sharpening-probe-dx12.exe" /link d3d12.lib dxgi.lib d3dcompiler.lib user32.lib gdi32.lib
exit /b %errorlevel%
