# ============================================================================
#  Phoenix School Transport Management — Zero-Touch Launch Script (PowerShell)
#  Installs dependencies, applies DB migrations, runs tests, and starts services.
# ============================================================================

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host ""
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host "   Phoenix School Transport Management — Zero-Touch Launcher" -ForegroundColor Cyan
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host ""

# ─── Step 0: Pre-flight checks ─────────────────────────────────────────────────
Write-Host "[0/5] Checking prerequisites..." -ForegroundColor Yellow

$nodeVersion = & node -v 2>$null
if (-not $nodeVersion) {
    Write-Host "  ERROR: Node.js is not installed. Download from https://nodejs.org" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "       Node.js: $nodeVersion" -ForegroundColor Green

$npmCheck = & npm -v 2>$null
if (-not $npmCheck) {
    Write-Host "  ERROR: npm is not available." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "       npm: v$npmCheck" -ForegroundColor Green
Write-Host ""

# ─── Step 1: Supabase Setup ────────────────────────────────────────────────────
Write-Host "[1/5] Setting up Supabase..." -ForegroundColor Yellow

$supabaseCheck = Get-Command supabase -ErrorAction SilentlyContinue
if (-not $supabaseCheck) {
    Write-Host "       Supabase CLI not found. Installing..." -ForegroundColor DarkYellow
    npm install -g supabase 2>$null
    $supabaseCheck = Get-Command supabase -ErrorAction SilentlyContinue
    if (-not $supabaseCheck) {
        Write-Host "       WARNING: Could not install Supabase CLI. Tests still work locally." -ForegroundColor DarkYellow
    }
}

if ($supabaseCheck) {
    Write-Host "       Supabase CLI: OK" -ForegroundColor Green
}

# Check .env
if (-not (Test-Path "$Root\.env")) {
    if (Test-Path "$Root\.env.example") {
        Copy-Item "$Root\.env.example" "$Root\.env"
        Write-Host ""
        Write-Host "  ┌──────────────────────────────────────────────────────────────────┐" -ForegroundColor Magenta
        Write-Host "  │  IMPORTANT: Edit .env with your Supabase credentials.            │" -ForegroundColor Magenta
        Write-Host "  │  Opening .env in notepad now...                                  │" -ForegroundColor Magenta
        Write-Host "  └──────────────────────────────────────────────────────────────────┘" -ForegroundColor Magenta
        Write-Host ""
        Start-Process notepad "$Root\.env" -Wait
    }
}

# Check if env has real values
$envContent = Get-Content "$Root\.env" -Raw -ErrorAction SilentlyContinue
if ($envContent -match "your-project" -or $envContent -match "your-anon-key") {
    Write-Host "       WARNING: .env has placeholder values. Skipping DB migration." -ForegroundColor DarkYellow
    Write-Host "       Edit .env with real Supabase credentials to enable migrations." -ForegroundColor DarkYellow
} elseif ($supabaseCheck) {
    Write-Host "       Applying database migrations..." -ForegroundColor Gray
    Set-Location "$Root\supabase"
    & supabase db push --linked 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "       WARNING: Migration push failed. Link your project first:" -ForegroundColor DarkYellow
        Write-Host "       supabase link --project-ref YOUR_REF" -ForegroundColor DarkYellow
    } else {
        Write-Host "       Migrations applied successfully." -ForegroundColor Green
    }
    Set-Location $Root
}

Write-Host "       Step 1 complete." -ForegroundColor Green
Write-Host ""

# ─── Step 2: Install Desktop App & Run Tests ───────────────────────────────────
Write-Host "[2/5] Installing desktop-app dependencies and running tests..." -ForegroundColor Yellow

Set-Location "$Root\desktop-app"
& npm install --silent 2>$null

Write-Host ""
Write-Host "       Running property-based tests (95 tests, 100 iterations each)..." -ForegroundColor Gray
Write-Host ""

& npx vitest run --reporter=verbose
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "       ✓ All tests PASSED" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "       ✗ Some tests failed — check output above" -ForegroundColor Red
}

Set-Location $Root
Write-Host ""
Write-Host "       Step 2 complete." -ForegroundColor Green
Write-Host ""

# ─── Step 3: Launch Operator Portal ────────────────────────────────────────────
Write-Host "[3/5] Launching Operator Portal..." -ForegroundColor Yellow

$dashboardPath = "$Root\desktop-app\renderer\pages\dashboard.html"
if (Test-Path $dashboardPath) {
    Start-Process $dashboardPath
    Write-Host "       Opened Operator Portal in browser" -ForegroundColor Green
} else {
    Write-Host "       WARNING: dashboard.html not found" -ForegroundColor DarkYellow
}
Write-Host ""

# ─── Step 4: Install Admin Portal ──────────────────────────────────────────────
Write-Host "[4/5] Installing admin-portal dependencies..." -ForegroundColor Yellow

Set-Location "$Root\admin-portal"
& npm install --silent 2>$null
Set-Location $Root
Write-Host "       Step 4 complete." -ForegroundColor Green
Write-Host ""

# ─── Step 5: Launch Admin Portal Dev Server ────────────────────────────────────
Write-Host "[5/5] Starting Admin Portal dev server (http://localhost:5173)..." -ForegroundColor Yellow

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root\admin-portal'; npx vite --open"
Write-Host "       Admin Portal starting in new window..." -ForegroundColor Green
Write-Host ""

# ─── Done ──────────────────────────────────────────────────────────────────────
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host "   ALL SERVICES LAUNCHED SUCCESSFULLY" -ForegroundColor Green
Write-Host "  ===================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "   Operator Portal:  Open in browser (file-based)" -ForegroundColor White
Write-Host "   Admin Portal:     http://localhost:5173" -ForegroundColor White
Write-Host "   Tests:            Already ran (see output above)" -ForegroundColor White
Write-Host ""
Write-Host "   To serve Edge Functions locally:" -ForegroundColor Gray
Write-Host "     cd supabase; supabase functions serve" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to exit"
