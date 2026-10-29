@echo off
rem Runs delegate.sh with Git Bash from cmd or PowerShell. A bare `bash` there can resolve to WSL
rem (C:\Windows\System32\bash.exe), which fails with a relay error or runs in the wrong system.
setlocal
set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%GITBASH%" for /f "delims=" %%G in ('where git 2^>nul') do if not defined GB set "GB=%%~dpG..\bin\bash.exe"
if not exist "%GITBASH%" if defined GB set "GITBASH=%GB%"
if not exist "%GITBASH%" (echo boxie: Git Bash not found; install Git for Windows 1>&2 & exit /b 1)
"%GITBASH%" "%~dp0delegate.sh" %*
