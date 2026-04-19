@echo off
chcp 65001 >nul 2>&1
title Claude Max 챌린지 - 자동 실행 등록
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
    echo.
    echo   [X] Python을 찾을 수 없습니다.
    echo       Python을 먼저 설치해주세요.
    echo.
    echo ========================================
    echo   아무 키나 누르면 창이 닫힙니다.
    echo ========================================
    pause >nul
    exit /b 1
)

echo   [O] Python: %PY%

:: 스크립트 존재 확인
set SCRIPT=%USERPROFILE%\.claude\challenge-report.py
if not exist "%SCRIPT%" (
    echo.
    echo   [X] challenge-report.py 파일이 없습니다.
    echo       아래 경로에 파일을 먼저 넣어주세요:
    echo       %SCRIPT%
    echo.
    echo ========================================
    echo   아무 키나 누르면 창이 닫힙니다.
    echo ========================================
    pause >nul
    exit /b 1
)

echo   [O] 스크립트: %SCRIPT%
echo.
echo   등록 중...

:: PowerShell로 스케줄러 등록
:: 매 정각마다 개별 Daily Trigger 24개 등록 (단일 RepetitionInterval 방식은 절전 복귀 후 trigger를 놓치는 이슈가 있음)
:: ExecutionTimeLimit 30분 (48h 스캔 + 3회 전송 여유)
powershell -Command "& { $a = New-ScheduledTaskAction -Execute '%PY%' -Argument '%SCRIPT%'; $triggers = @(); for ($h = 0; $h -lt 24; $h++) { $triggers += New-ScheduledTaskTrigger -Daily -At ([datetime]('{0:D2}:00' -f $h)) }; $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30); Register-ScheduledTask -TaskName 'ClaudeChallenge' -Action $a -Trigger $triggers -Settings $s -Force | Out-Null }" 2>nul

if %errorlevel% neq 0 (
    echo.
    echo ========================================
    echo   [X] 등록 실패
    echo.
    echo   이 파일을 우클릭 →
    echo   "관리자 권한으로 실행" 해주세요.
    echo ========================================
    echo.
    echo   아무 키나 누르면 창이 닫힙니다.
    pause >nul
    exit /b 1
)

echo.
echo ========================================
echo.
echo   [O] 등록 성공!
echo.
echo   매 정각마다 자동으로 보고됩니다.
echo   PC를 껐다 켜도 유지됩니다.
echo.
echo ========================================
echo.
echo   아무 키나 누르면 창이 닫힙니다.
pause >nul
