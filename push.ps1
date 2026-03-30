# Try to use gh from a fresh PATH, or guide user through manual steps
$machinePath = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
$userPath    = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH    = "$machinePath;$userPath"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
    Write-Host "gh found at $($gh.Source)"
    & gh auth login
    & gh repo create outbound-dashboard --public --push --source="C:\Users\eyoha\outbound-dashboard"
} else {
    Write-Host ""
    Write-Host "========================================================"
    Write-Host "  gh CLI is installed but needs a new terminal to load."
    Write-Host "========================================================"
    Write-Host ""
    Write-Host "Please open a NEW PowerShell window and run:"
    Write-Host ""
    Write-Host "  cd C:\Users\eyoha\outbound-dashboard"
    Write-Host "  gh auth login"
    Write-Host "  gh repo create outbound-dashboard --public --push --source=."
    Write-Host ""
    Write-Host "Or push manually:"
    Write-Host "  1. Go to https://github.com/new"
    Write-Host "  2. Create repo named: outbound-dashboard  (public, no README)"
    Write-Host "  3. Then run in this folder:"
    Write-Host "       git remote add origin https://github.com/YOUR_USERNAME/outbound-dashboard.git"
    Write-Host "       git branch -M main"
    Write-Host "       git push -u origin main"
}
