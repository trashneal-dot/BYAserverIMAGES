@echo off
rem Double-click launcher for the Skeng Skin Manager.
rem Runs the built exe; builds it first if missing (needs the .NET 8 SDK on PATH).
cd /d "%~dp0"
set "EXE=bin\Release\net8.0-windows\SkengSkinManager.exe"
if not exist "%EXE%" (
  echo Building Skeng Skin Manager...
  dotnet build -c Release || ( echo Build failed. & pause & exit /b 1 )
)
start "" "%EXE%"
