# test-smtp.ps1 - local submission test
# Usage: .\test-smtp.ps1

param(
    [string]$Server = "localhost",
    [int]$Port = 2525,
    [string]$From = "test@localhost",
    [string]$To = "submit@localhost",
    [string]$Subject = "Hello treehole",
    [string]$Body = "This is a test submission."
)

Write-Host "=== Treehole SMTP test ===" -ForegroundColor Cyan
Write-Host ""

function Send-Command($writer, $reader, $cmd, $label) {
    Write-Host ">>> $label" -ForegroundColor Yellow
    $writer.WriteLine($cmd)
    $writer.Flush()
    Start-Sleep -Milliseconds 500
    $lines = @()
    while ($reader.Peek() -ge 0 -or $stream.DataAvailable) {
        $line = $reader.ReadLine()
        if ($line) {
            Write-Host "<<< $line" -ForegroundColor DarkGray
            $lines += $line
        }
        Start-Sleep -Milliseconds 200
        if ($reader.Peek() -lt 0 -and -not $stream.DataAvailable) { break }
    }
    return $lines -join "`n"
}

try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect($Server, $Port)
    $stream = $tcp.GetStream()
    $writer = New-Object System.IO.StreamWriter($stream)
    $reader = New-Object System.IO.StreamReader($stream)
    $writer.AutoFlush = $true

    # read the greeting banner
    Start-Sleep -Milliseconds 500
    while ($stream.DataAvailable) {
        $line = $reader.ReadLine()
        if ($line) { Write-Host "<<< $line" -ForegroundColor DarkGray }
    }

    # EHLO
    Send-Command $writer $reader "EHLO test" "EHLO"
    # MAIL FROM
    Send-Command $writer $reader "MAIL FROM:<${From}>" "MAIL FROM"
    # RCPT TO
    Send-Command $writer $reader "RCPT TO:<${To}>" "RCPT TO"
    # DATA
    Send-Command $writer $reader "DATA" "DATA"

    # send the message body after the 354 response
    Start-Sleep -Milliseconds 300
    Write-Host ">>> (sending message body)" -ForegroundColor Yellow
    $writer.WriteLine("Subject: ${Subject}")
    $writer.WriteLine("From: ${From}")
    $writer.WriteLine("To: ${To}")
    $writer.WriteLine("")
    $writer.WriteLine($Body)
    $writer.WriteLine(".")
    $writer.Flush()

    # read the final response
    Start-Sleep -Milliseconds 1000
    while ($stream.DataAvailable) {
        $line = $reader.ReadLine()
        if ($line) { Write-Host "<<< $line" -ForegroundColor DarkGray }
    }

    # QUIT
    Send-Command $writer $reader "QUIT" "QUIT"

    $writer.Close(); $reader.Close(); $stream.Close(); $tcp.Close()

    Write-Host ""
    Write-Host "=== result ===" -ForegroundColor Green
    Write-Host "  docker logs treehole-haraka --tail 20"
    Write-Host "  docker logs treehole-web --tail 10"
    Write-Host "  docker exec treehole-redis redis-cli SMEMBERS authorized:emails"

} catch {
    Write-Host "connection failed: $($_.Exception.Message)" -ForegroundColor Red
}
