export PATH=/vol2/@appcenter/nodejs_v24/bin:$PATH
cd /vol2/@appshare/Harness/qqbot-fork
pnpm run build 2>&1 | grep -E "error TS" | head -4
