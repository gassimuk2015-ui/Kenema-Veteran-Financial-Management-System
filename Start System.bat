@echo off
title Kenema Veteran Financial Management System
echo ==========================================================
echo   Kenema Veteran Financial Management System
echo   Starting server...
echo   Open http://localhost:3000 in your browser
echo   Default login -^> username: admin   password: admin123
echo   (Press Ctrl+C here to stop the server)
echo ==========================================================
node "%~dp0server.js"
pause
