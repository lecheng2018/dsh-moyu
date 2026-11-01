export PATH=/vol2/@appcenter/nodejs_v24/bin:$PATH
cd /vol2/@appshare/Harness
rm -rf qqbot-fork && mkdir qqbot-fork
tar -xzf qqbot-fork.tar.gz -C qqbot-fork
cd qqbot-fork
pnpm install --frozen-lockfile 2>&1 | tail -1
echo "TS errors: $(pnpm run build 2>&1 | grep -cE 'error TS')"
npx vitest run 2>&1 | grep -E "Test Files|Tests " | head -3
pnpm pack 2>&1 | tail -1
