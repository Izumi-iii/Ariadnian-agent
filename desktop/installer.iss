; Ariadne Windows 安装程序（Inno Setup 6）
; npm run desktop 会在装有 Inno Setup 时自动调用；也可以手动：
;   iscc /DAppVersion=0.1.0 desktop\installer.iss
; 安装到当前用户目录，不需要管理员权限；卸载时保留 %APPDATA%\Ariadne 里的文献库和论文。

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{A2C614DF-96A9-4E7C-B05D-FD1107327585}
AppName=Ariadne
AppVersion={#AppVersion}
AppVerName=Ariadne {#AppVersion}
AppPublisher=tkzzzzzz6
AppPublisherURL=https://github.com/tkzzzzzz6/Ariadnian-Agent
DefaultDirName={localappdata}\Programs\Ariadne
DefaultGroupName=Ariadne
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=Ariadne-Setup-{#AppVersion}
SetupIconFile=ariadne.ico
UninstallDisplayIcon={app}\Ariadne.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\Ariadne\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Ariadne"; Filename: "{app}\Ariadne.exe"
Name: "{group}\{cm:UninstallProgram,Ariadne}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Ariadne"; Filename: "{app}\Ariadne.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Ariadne.exe"; Description: "{cm:LaunchProgram,Ariadne}"; Flags: nowait postinstall skipifsilent
