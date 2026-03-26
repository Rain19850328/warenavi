param(
    [int]$DailyStockDays = 7,
    [switch]$DryRun,
    [switch]$FullDailyStock,
    [string]$FromDate = "",
    [string]$ToDate = ""
)

if (-not $env:SUPABASE_DB_URL) {
    Write-Error "SUPABASE_DB_URL environment variable is required."
    exit 1
}

$args = @(".\sync_mysql_reference_data.py", "--daily-stock-days", "$DailyStockDays")

if ($DryRun) {
    $args += "--dry-run"
}

if ($FullDailyStock) {
    $args += "--full-daily-stock"
}

if ($FromDate -and $ToDate) {
    $args += "--from-date"
    $args += $FromDate
    $args += "--to-date"
    $args += $ToDate
}

python @args
