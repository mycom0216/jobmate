@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 이상이 필요합니다. https://nodejs.org 에서 설치하세요. & pause & exit /b 1)
echo JobMate를 시작합니다. 종료하려면 이 창에서 Ctrl+C 를 누르세요.
start "" http://127.0.0.1:5400
node server.mjs
pause
