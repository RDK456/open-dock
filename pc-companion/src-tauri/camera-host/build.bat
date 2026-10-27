@echo off
rem Builds ..\resources\opendock_vcam.dll and ..\resources\dockcam.exe with the VS 2022 C++ build tools.
setlocal
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
set "VS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
if not exist "%VS%\VC\Auxiliary\Build\vcvars64.bat" set "VS=%ProgramFiles%\Microsoft Visual Studio\2022\Community"
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist out mkdir out

cl /nologo /Brepro /O2 /EHsc /std:c++17 /W3 /MT /LD vcam.cpp /Fe:out\opendock_vcam.dll /Fo:out\ ^
   /link /Brepro /DEF:vcam.def mfplat.lib mfuuid.lib ole32.lib advapi32.lib || exit /b 1

cl /nologo /Brepro /utf-8 /O2 /EHsc /std:c++17 /W3 /MT host.cpp /Fe:out\dockcam.exe /Fo:out\ ^
   /link /Brepro /SUBSYSTEM:CONSOLE mfplat.lib mfuuid.lib mf.lib mfsensorgroup.lib wmcodecdspuuid.lib ^
   ole32.lib shell32.lib advapi32.lib user32.lib || exit /b 1

copy /y out\opendock_vcam.dll ..\resources\ >nul
copy /y out\dockcam.exe ..\resources\ >nul
echo Built dockcam.exe and opendock_vcam.dll into ..\resources
