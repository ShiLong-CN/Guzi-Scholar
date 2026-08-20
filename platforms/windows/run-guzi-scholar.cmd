@echo off
rem Windows consoles default to a legacy code page; without this the Chinese
rem messages below print as mojibake.
chcp 65001 >nul
rem Development launcher for the Windows build (run from a checkout, not the
rem installer). Requires Node.js and Python 3 on PATH.
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%..\..\apps\desktop" || exit /b 1

where node >nul 2>&1 || (
  echo [错误] 未找到 Node.js，请先安装：https://nodejs.org/
  popd & exit /b 1
)

set "PYOK="
for %%P in ("py -3" "python" "python3") do (
  if not defined PYOK (
    for /f "tokens=2 delims= " %%V in ('%%~P --version 2^>^&1') do (
      for /f "tokens=1,2 delims=." %%A in ("%%V") do (
        if %%A EQU 3 if %%B GEQ 9 set "PYOK=1"
      )
    )
  )
)
if not defined PYOK (
  echo [错误] 未找到 Python 3.9 或更高版本，请安装：https://www.python.org/downloads/windows/
  popd ^& exit /b 1
)

if not exist "node_modules\electron" (
  echo ==^> 正在安装依赖...
  call npm install || (popd & exit /b 1)
)

echo ==^> 启动谷子学术...
call npm run dev
popd
endlocal
