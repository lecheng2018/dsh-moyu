export PATH=/vol2/@appcenter/nodejs_v24/bin:$PATH
cd /vol2/@appshare/Harness
rm -rf qqbot-fork && mkdir qqbot-fork
tar -xzf qqbot-fork.tar.gz -C qqbot-fork
cd qqbot-fork
pnpm install --frozen-lockfile 2>&1 | tail -1
echo "TS errors: $(pnpm run build 2>&1 | grep -cE 'error TS')"
npx vitest run 2>&1 | grep -E "Test Files|Tests " | head -3
pnpm pack 2>&1 | tail -1
echo "=== 未动 profile(按用户要求不部署) ==="
cat /vol2/@appshare/Harness/.dsh/profiles/web/node_modules/@zhoukai/dsh-qqbot/package.json 2>/dev/null | python3 -c "import json,sys;print('profile 仍是:',json.load(sys.stdin)['version'])"
