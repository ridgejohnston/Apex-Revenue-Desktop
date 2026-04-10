APEX REVENUE DESKTOP v1.0.0
Creator Intelligence Engine for Windows
════════════════════════════════════════

QUICK START
───────────
1. Extract this ZIP to wherever you want the app to live, e.g.:
      C:\Users\Ridge\Apps\Apex Revenue\

2. Run the setup script to create your Desktop + Start Menu shortcuts:
      Right-click  Setup-ApexRevenue.ps1
      → "Run with PowerShell"

   If PowerShell execution is restricted, open a terminal and run:
      powershell -ExecutionPolicy Bypass -File Setup-ApexRevenue.ps1

3. Or just double-click "Apex Revenue.exe" directly — no setup required.


WHY A ZIP INSTEAD OF AN INSTALLER?
────────────────────────────────────
The NSIS installer (.exe) gets blocked by Windows Application Control
because it is unsigned. The app itself is fine — the Electron binary
("Apex Revenue.exe") is signed by Electron Inc. and trusted by Windows.

Extracting the ZIP bypasses the installer block entirely.


AUTO-UPDATES
────────────
The app checks for updates automatically:
  • 12 seconds after each launch
  • Every 4 hours while running

When a new version is available, it downloads silently in the background.
A banner appears in the app header. Click "Restart & Install" to apply.

Updates are served from:
  https://apex-revenue-updates-994438967527.s3.amazonaws.com/latest.yml


UNINSTALL
──────────
1. Delete this folder.
2. Delete the Desktop / Start Menu shortcuts (if created).
3. App data is stored at:
      %APPDATA%\apex-revenue-data


SUPPORT
───────
https://apexrevenue.works
