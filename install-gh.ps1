$zip  = "$env:TEMP\gh.zip"
$dest = "$env:TEMP\gh-extract"
$out  = "C:\Users\eyoha\outbound-dashboard\gh.exe"

Write-Host "Downloading GitHub CLI..."
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://github.com/cli/cli/releases/download/v2.88.1/gh_2.88.1_windows_amd64.zip" `
  -OutFile $zip

Write-Host "Extracting..."
Expand-Archive -Path $zip -DestinationPath $dest -Force

$ghBin = Get-ChildItem -Path $dest -Recurse -Filter "gh.exe" | Select-Object -First 1
Copy-Item $ghBin.FullName $out

Write-Host "Done! Testing..."
& $out --version
