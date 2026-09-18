@echo off
setlocal
set LOCAL_AUTH_SEED_USERNAME=admin
set LOCAL_AUTH_SEED_PASSWORD=admin
set NODE_ENV=development
node server.js
endlocal
