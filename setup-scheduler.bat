@echo off
chcp 65001 >nul 2>&1
echo.
echo ========================================
echo   Claude Max 챌린지 - 자동 실행 등록
echo ========================================
echo.

:: Python 자동 탐지
set PY=
for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PY set "PY=%%i"
)

if not defined PY (
    echo [오류] Python을 찾을 수 없습니다.
    echo        Python을 먼저 설치해주세요.
    echo.
    pause
    exit /b 1
)

echo [확인] Python 경로: %PY%
echo.

:: 스크립트 존재 확인
set SCRIPT=%USERPROFILE%\.claude\challenge-report.py
if not exist "%SCRIPT%" (
    echo [오류] challenge-report.py 파일이 없습니다.
    echo        아래 경로에 파일을 먼저 넣어주세요:
    echo        %SCRIPT%
    echo.
    pause
    exit /b 1
)

echo [확인] 스크립트: %SCRIPT%
echo.

:: PowerShell로 스케줄러 등록 (배터리 모드 OK, 놓친 실행 보충)
echo [진행] 1시간마다 자동 실행 등록 중...
powershell -Command "& { $a = New-ScheduledTaskAction -Execute '%PY%' -Argument '%SCRIPT%'; $t = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Hours 1); $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10); Register-ScheduledTask -TaskName 'ClaudeChallenge' -Action $a -Trigger $t -Settings $s -Force | Out-Null; Write-Host '[완료] 자동 실행 등록 성공!' -ForegroundColor Green }"

if %errorlevel% neq 0 (
    echo.
    echo [오류] 등록 실패. 관리자 권한으로 다시 실행해주세요.
    echo        이 파일을 우클릭 → "관리자 권한으로 실행"
    echo.
    pause
    exit /b 1
)

echo.
echo ----------------------------------------
echo   매 정각마다 자동으로 사용량이 보고됩니다.
echo   PC를 껐다 켜도 유지됩니다.
echo ----------------------------------------
echo.
pause
