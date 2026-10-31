export PATH=/vol2/@appcenter/nodejs_v24/bin:$PATH
cd /vol2/@appshare/Harness/qqbot-fork
npx vitest run 2>&1 | grep -B3 -A18 "FAIL\|AssertionError" | head -40
